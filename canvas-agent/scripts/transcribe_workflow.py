"""Local-only speech transcription. Never inject the intended script into ASR."""
import json
import gc
import os
from pathlib import Path
import re
import sys

from faster_whisper import WhisperModel
from faster_whisper.vad import get_vad_model

folder = Path(sys.argv[1])
spec = json.loads((folder / "snapshot.json").read_text())
model = WhisperModel(os.environ["WORKFLOW_WHISPER_MODEL"], device="cpu", compute_type="int8", local_files_only=True)
cues = []
evidence = []
for index, shot in enumerate(spec["shots"]):
    segments, info = model.transcribe(str(folder / f"shot-{index}.mp4"), language="zh", word_timestamps=True, vad_filter=True)
    for segment in segments:
        evidence.append({"shot": index, "start": segment.start, "end": segment.end, "text": segment.text, "no_speech_prob": segment.no_speech_prob, "avg_logprob": segment.avg_logprob})
        words = segment.words or []
        phrase = ""
        start = None
        for i, word in enumerate(words):
            if start is None:
                start = word.start
            phrase += word.word
            if re.search(r"[，。！？,!?；;]$", phrase) or i == len(words) - 1:
                end = min(word.end, shot["duration"])
                if phrase.strip() and end > start:
                    cues.append({"shot": index, "start": round(start, 3), "end": round(end, 3), "text": phrase.strip()})
                phrase, start = "", None
    print(f"Transcribed shot {index + 1}", flush=True)

# Recognition is a draft, not proof of accurate narration or human review.
output = {"cues": cues, "evidence": evidence, "source": "local-faster-whisper", "reviewed": False}
temporary = folder / "subtitles-draft.json.tmp"
temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2))
temporary.replace(folder / "subtitles-draft.json")
# Release native inference sessions before Python begins module teardown on macOS.
del model
get_vad_model.cache_clear()
gc.collect()
