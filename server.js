const express = require("express");
const bodyParser = require("body-parser");
const { OpenAI } = require("openai");
const twilio = require("twilio");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Create transporter for email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Hi! This is Ava, Alex's AI assistant. May I ask what this call is about? Please leave your message after the beep.");
  twiml.record({
    maxLength: 60,
    action: "/process-recording",
    transcribe: true,
    transcribeCallback: "/transcription",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/transcription", async (req, res) => {
  const transcript = req.body.TranscriptionText || "";

  try {
    const response = await openai.chat.completions.create({
      messages: [
        { role: "user", content: `Summarize and classify this voicemail. Is it spam? Voicemail: "${transcript}"` }
      ],
      model: "gpt-4",
    });

    const summary = response.choices[0].message.content;

    if (!summary.toLowerCase().includes("spam")) {
      await transporter.sendMail({
        from: process.env.EMAIL_USERNAME,
        to: "alex@ineedroof.com",
        subject: "New Voicemail Summary from Ava",
        text: summary,
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error:", error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));