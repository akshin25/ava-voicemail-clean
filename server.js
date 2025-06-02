// Import necessary modules
const express = require("express"); // For creating and managing the server
const multer = require("multer"); // For handling multipart/form-data (file uploads)
const fs = require("fs"); // Node.js built-in module for file system operations
const path = require("path"); // Node.js built-in module for working with file and directory paths
const OpenAI = require("openai"); // OpenAI API client library
const twilio = require("twilio"); // Twilio API client library - IMPORTANT for TwiML
const nodemailer = require("nodemailer"); // NEW: For sending emails

// Polyfill for 'File' constructor in Node.js environment for OpenAI API
// This is necessary because OpenAI's library expects a browser-like 'File' object
// when dealing with audio files, which Node.js doesn't have natively.
if (typeof File === 'undefined') {
  global.File = class File extends Blob {
    constructor(chunks, name, options) {
      super(chunks, options);
      this.name = name;
      this.lastModified = new Date().getTime();
    }
  };
}

// --- Configuration ---
// Load environment variables (like your API key) from a .env file
require("dotenv").config();

// Initialize OpenAI API client with your API key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// NEW: Configure Nodemailer transporter for Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use 'gmail' as the service
  auth: {
    user: process.env.EMAIL_USERNAME, // Your Gmail address from .env
    pass: process.env.EMAIL_PASSWORD  // Your App Password from .env
  }
});

// Set up Express application
const app = express();
// Define the port your server will listen on. Render will set process.env.PORT.
const port = process.env.PORT || 3000;

// --- Multer Storage Configuration ---
// Note: 'uploads/' directory must exist or be created for Multer to work.
// For Render, this is temporary storage during processing.
const upload = multer({ dest: "uploads/" });

// --- Middleware ---
// Parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the 'public' directory (if you had any)
app.use(express.static("public"));

// --- Routes ---

// Default route for the homepage
app.get("/", (req, res) => {
  res.send("Welcome to the AI Voicemail Assistant API!");
});

// Twilio Voice Webhook Endpoint
// This endpoint is hit when a call comes in to your Twilio number.
app.post("/voice", async (req, res) => {
  console.log("📞 Incoming Twilio Voice Webhook Request Received");

  const twiml = new twilio.twiml.VoiceResponse();

  // New Greeting for AVA - SIMPLIFIED FOR TESTING
  twiml.say(
    { voice: "alice", language: "en-US" }, // Set your desired natural voice here
    "Hello. This is a final test." // THIS LINE WAS CHANGED
  );

  // Record the caller's message
  twiml.record({
    maxLength: 60, // Maximum recording length in seconds
    timeout: 5, // How long to wait for silence before ending recording
    transcribe: false, // Set to false because we'll do transcription on our server using OpenAI Whisper
    action: "/recording-complete", // Twilio sends the recording URL to this endpoint for processing
    method: "POST", // Use POST for the action webhook
  });

  // REMOVED: twiml.hangup(); from here

  // Send the TwiML response back to Twilio
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// Endpoint to handle the recording completion action from Twilio's <Record> verb's 'action' attribute.
// This endpoint now fetches the audio, transcribes it, summarizes it, and talks back to the caller.
app.post("/recording-complete", async (req, res) => {
  console.log("🟢 Recording Complete Webhook Received.");
  console.log("--- Recording Complete Body ---");
  console.log(req.body); // Log the entire request body to see all parameters Twilio sends

  const recordingUrl = req.body.RecordingUrl;
  const twiml = new twilio.twiml.VoiceResponse(); // Initialize TwiML response here

  // Basic validation for recording URL
  if (!recordingUrl || (typeof recordingUrl === 'string' && recordingUrl.trim() === '')) {
    console.error("❌ No valid RecordingUrl provided for /recording-complete.");
    twiml.say({ voice: "Polly.Kevin", language: "en-US" }, "I apologize, but I didn't receive a clear recording. Please try again later. Goodbye.");
    twiml.hangup();
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml.toString());
  }
  console.log(`🎵 Received recording URL: ${recordingUrl}`);

  let aiAnalysis = "No AI summary available."; // Default in case of AI error
  let transcriptionText = "No transcription available."; // Default in case of transcription error

  try {
    // --- Step 1: Fetch the audio recording from Twilio ---
    // You need your Twilio Account SID and Auth Token to authenticate the download
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const authHeader = 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64');

    // NEW: Implement retry logic for fetching the audio
    const maxRetries = 3;
    const retryDelayMs = 2000; // 2 seconds delay

    let audioResponse;
    for (let i = 0; i < maxRetries; i++) {
      try {
        audioResponse = await fetch(recordingUrl, {
          headers: { 'Authorization': authHeader }
        });

        if (audioResponse.ok) {
          console.log(`✅ Recording fetched successfully on attempt ${i + 1}.`);
          break; // Exit loop if successful
        } else if (audioResponse.status === 404 && i < maxRetries - 1) {
          console.warn(`⚠️ Recording not found (404) on attempt ${i + 1}. Retrying in ${retryDelayMs / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        } else {
          // For other errors or last retry attempt, throw the error
          throw new Error(`Failed to fetch audio from Twilio URL: ${audioResponse.statusText} (Status: ${audioResponse.status})`);
        }
      } catch (err) {
        if (i < maxRetries - 1) {
          console.warn(`⚠️ Error fetching recording on attempt ${i + 1}: ${err.message}. Retrying in ${retryDelayMs / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        } else {
          throw err; // Re-throw the error on the last attempt
        }
      }
    }

    if (!audioResponse || !audioResponse.ok) {
      // This means all retries failed or an unrecoverable error occurred
      throw new Error("Failed to fetch audio from Twilio after multiple retries.");
    }
    const audioBuffer = await audioResponse.buffer();

    // Create a 'File' object from the buffer for OpenAI API
    const originalname = path.basename(recordingUrl).split('?')[0] || 'recording.wav';
    const mimetype = audioResponse.headers.get('content-type') || 'audio/wav';

    const audioFile = new File([audioBuffer], originalname, { type: mimetype });

    // --- Step 2: Transcribe the audio using OpenAI Whisper ---
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1", // Using the Whisper ASR model
    });
    transcriptionText = transcription.text; // Assign to outer scope variable
    console.log("✅ Transcription successful:", transcriptionText);

    // --- Step 3: Summarize and extract info using OpenAI GPT ---
    const prompt = `Summarize the following voicemail transcription. Extract the caller's name, their company (if mentioned), their callback number (if provided), and the main reason for their call. If a callback number is not explicitly stated, mention that it's "Not provided". If no name or company is given, state "Not provided".

    Voicemail: "${transcriptionText}"

    Format the output as follows:
    Summary: [Concise summary of the voicemail]
    Caller Name: [Name or "Not provided"]
    Company: [Company or "Not provided"]
    Callback Number: [Number or "Not provided"]
    Reason for Call: [Main purpose of the call]
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Consider "gpt-4" for higher quality if available
      messages: [
        { role: "system", content: "You are a helpful assistant that summarizes voicemails and extracts key information." },
        { role: "user", content: prompt }
      ],
      max_tokens: 400, // Limit the length of the AI's response
      temperature: 0.7, // Creativity level
    });

    aiAnalysis = completion.choices[0].message.content; // Assign to outer scope variable
    console.log("🧠 AI Analysis Complete:\n", aiAnalysis);

    // --- NEW: Step 4: Send Email with AI Analysis ---
    const mailOptions = {
      from: process.env.EMAIL_USERNAME, // Sender email address (your personal Gmail)
      to: process.env.EMAIL_USERNAME,    // Recipient email address (Alex's personal Gmail)
      subject: `New Voicemail from AVA: ${transcriptionText.substring(0, 50)}...`, // Subject line
      html: `
        <p>You have a new voicemail from AVA!</p>
        <h3>Original Transcription:</h3>
        <p>${transcriptionText}</p>
        <h3>AI Analysis:</h3>
        <pre>${aiAnalysis}</pre>
        <p>Listen to the original recording: <a href="${recordingUrl}">${recordingUrl}</a></p>
      `
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("❌ Error sending email:", error);
      } else {
        console.log("✅ Email sent:", info.response);
      }
    });

    // --- Step 5: Speak the summary back to the caller and ask for more input ---
    // Extract just the summary part from the AI analysis for speech
    const summarySpeech = aiAnalysis.split('Summary: ')[1]?.split('\n')[0] || "I have received your message.";
    twiml.say({ voice: "Polly.Kevin", language: "en-US" }, `Thank you for your message. Here is a summary: ${summarySpeech}.`);

    // Gather potential follow-up speech from the caller
    twiml.gather({
      input: 'speech', // Accept speech input
      timeout: 5, // Wait 5 seconds for speech
      action: '/handle-followup', // Send follow-up response to this endpoint
      method: 'POST',
    }).say({ voice: "Polly.Kevin", language: "en-US" }, "Can I help with anything else regarding your message?");

    // If the caller doesn't speak or the recording ends, hang up
    twiml.say({ voice: "Polly.Kevin", language: "en-US" }, "Goodbye.");
    twiml.hangup();

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (error) {
    console.error("❌ Processing error in /recording-complete:", error);
    // Attempt to send an error email for basic notification
    const errorMailOptions = {
      from: process.env.EMAIL_USERNAME,
      to: process.env.EMAIL_USERNAME,
      subject: `AVA Voicemail Error: Could not process message`,
      html: `
        <p>An error occurred while processing a voicemail.</p>
        <p>Original Transcription (if available): ${transcriptionText}</p>
        <p>Error details: <pre>${error.message}</pre></p>
        <p>Recording URL: <a href="${recordingUrl}">${recordingUrl}</a></p>
      `
    };
    transporter.sendMail(errorMailOptions, (mailError, mailInfo) => {
      if (mailError) console.error("❌ Also failed to send error email:", mailError);
      else console.log("✅ Error email sent:", mailInfo.response);
    });

    // Inform the caller about the error
    const errorTwiml = new twilio.twiml.VoiceResponse();
    errorTwiml.say({ voice: "Polly.Kevin", language: "en-US" }, "I apologize, an error occurred while processing your message. Please try again later.");
    errorTwiml.hangup();
    res.writeHead(500, { "Content-Type": "text/xml" });
    res.end(errorTwiml.toString());
  }
});

// New endpoint to handle follow-up questions from the caller after the summary
app.post("/handle-followup", async (req, res) => {
  console.log("🗣️ Follow-up Webhook Received.");
  console.log("--- Follow-up Request Body ---");
  console.log(req.body); // Log the request body to see the SpeechResult

  const twiml = new twilio.twiml.VoiceResponse();
  const speechResult = req.body.SpeechResult; // Get the spoken input from the caller

  if (speechResult && speechResult.trim() !== '') {
    console.log(`Caller's follow-up: "${speechResult}"`);
    // Here you can add more advanced AI logic:
    // 1. Send this `speechResult` to GPT for another round of analysis based on the previous context.
    // 2. Potentially answer simple questions directly.
    // 3. Store this follow-up for Alex.

    // NEW: Send follow-up details via email
    const mailOptions = {
      from: process.env.EMAIL_USERNAME,
      to: process.env.EMAIL_USERNAME, // Alex's email
      subject: `AVA Voicemail Follow-up: "${speechResult.substring(0, 50)}..."`,
      html: `
        <p>Caller left a follow-up message with AVA:</p>
        <h3>Follow-up:</h3>
        <p>${speechResult}</p>
        <p>This was in response to the voicemail you just received.</p>
      `
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("❌ Error sending follow-up email:", error);
      } else {
        console.log("✅ Follow-up email sent:", info.response);
      }
    });

    twiml.say({ voice: "Polly.Kevin", language: "en-US" }, `You said: "${speechResult}". I will pass this additional information along to Alex. Thank you.`);
  } else {
    twiml.say({ voice: "Polly.Kevin", language: "en-US" }, "I didn't catch that. If you have more questions, please call back.");
  }
  twiml.hangup(); // End the call for now

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// The /transcription endpoint is now mostly redundant for the main call flow
// if we do server-side transcription and analysis in /recording-complete.
// However, if Twilio was still configured to send it, this would log it.
app.post("/transcription", async (req, res) => {
  console.log("⚠️ Incoming Twilio Transcription Webhook (Might be redundant with current flow).");
  console.log("--- Transcription Request Body ---");
  console.log(req.body);
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end('<Response/>'); // Respond with empty TwiML to acknowledge
});

/*
// The previous /ava endpoint is now effectively replaced by /recording-complete for live call interaction.
// It's kept here as a disabled placeholder for reference.
app.post("/ava", async (req, res) => {
  console.log("--- Incoming /ava Webhook (DISABLED in current flow) ---");
  console.log(req.headers);
  console.log(req.body);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("This endpoint is currently not active in the main call flow.");
  twiml.hangup();
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});
*/

// --- Server Start ---
// Start the Express server and listen for incoming requests
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
