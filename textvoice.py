from dotenv import load_dotenv
from flask import Flask, request, Response, send_file
from flask_cors import CORS
from elevenlabs.client import ElevenLabs
from elevenlabs import VoiceSettings
import os
import hashlib
import requests

app = Flask(__name__)
CORS(app)

load_dotenv()

# Configuration
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
VOICE_ID = "21m00Tcm4TlvDq8ikWAM"
CACHE_DIR = "audio_cache"

# Ensure cache directory exists
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

@app.route('/stream-tts', methods=['POST'])
def stream_tts():
    data = request.json
    text = data.get("text", "")
    
    if not text:
        return {"error": "No text provided"}, 400

    # Create a unique filename based on the text and voice
    text_hash = hashlib.md5(text.encode()).hexdigest()
    file_path = os.path.join(CACHE_DIR, f"{text_hash}.mp3")

    # --- CHECK CACHE ---
    if os.path.exists(file_path):
        print(f"Serving from cache: {file_path}")
        return send_file(file_path, mimetype="audio/mpeg")

    # --- FETCH FROM ELEVENLABS ---
    print("Fetching from ElevenLabs...")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
    }
    payload = {
        "text": text,
        "model_id": "eleven_turbo_v2", # Use turbo for speed
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.5}
    }

    response = requests.post(url, json=payload, headers=headers)

    if response.status_code == 200:
        # Save to cache
        with open(file_path, "wb") as f:
            f.write(response.content)
        # Return the newly saved file
        return send_file(file_path, mimetype="audio/mpeg")
    else:
        return {"error": "Failed to fetch from ElevenLabs"}, response.status_code

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)