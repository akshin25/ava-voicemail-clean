# AI Voicemail Assistant (Ava)

This is a simple Node.js server that handles voicemail recordings using Twilio, transcribes them, uses OpenAI to summarize and detect spam, and sends summaries to your email.

## Setup

1. Clone the repo or unzip this folder
2. Run `npm install`
3. Create a `.env` file (copy from `.env.example`) and add your credentials
4. Deploy to Render as a Web Service (Node.js)
5. Set your Twilio Voice Webhook URL to `https://your-render-app.onrender.com/voice`

## Notes

- You can customize the assistant's greeting in `server.js`
- Email summaries go to `alex@ineedroof.com`
# Ava is live!