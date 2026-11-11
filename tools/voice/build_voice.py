#!/usr/bin/env python3
"""
build_voice.py — regenerate Selah's narration (assets/voice/**) from tools/voice/script.json.

============================================================================================
 README
============================================================================================
WHAT IT MAKES
    assets/voice/<voice>/<lineId>.mp3   dry, mastered, mono MP3 per narration line
    assets/voice/manifest.json          { voices: { <voice>: { label, lines: { <id>: { file,
                                          duration, text, captions:[{t0,t1,text}] } } } }, default }
    Played at runtime by src/audio/narrator.js (which adds presence, reverb send and "aura").

HOW (offline neural TTS, no cloud)
    Mycroft Mimic 3 VITS voices (ONNX) driven by tools/voice/mimic3_lite.py:
        alan = en_UK/apope_low                 (calm British male, single speaker, 22.05 kHz)
        cori = en_US/hifi-tts_low  speaker 92  (soft British female, LibriVox reader)
    Per line (see script.json):
      1. every phrase is phonemised with gruut (+ lexicon overrides: "Selah" = s ˈeɪ l ˌɑ,
         "the" before a vowel = ði) and synthesised on its own, with the model's length scale
         for a slow, calm read (no time-stretching);
      2. N seeded takes per phrase; the take with the best ASR round-trip (pocketsphinx, if
         installed) and the most typical duration wins — fully deterministic for a given
         script/seed/onnxruntime build;
      3. takes are trimmed to the speech, micro-faded and assembled with the designed pauses,
         so caption times are known exactly (speech onset/offset of each phrase);
      4. ffmpeg mastering: high-pass, gentle warmth/presence EQ, de-ess, light compression,
         loudness-normalise to target_lufs (default -19 LUFS), peak limit, NO reverb;
      5. MP3 (libmp3lame, mono, native 22.05 kHz), then durations / caption times / loudness
         are re-measured from the decoded MP3 and written to the manifest.

SETUP (once)
    python3 -m venv .venv-voice && . .venv-voice/bin/activate   # anywhere OUTSIDE the repo
    pip install -r tools/voice/requirements.txt                 # numpy onnxruntime gruut (+pocketsphinx)
    ffmpeg with libmp3lame must be on PATH.

RUN
    python tools/voice/build_voice.py                 # all voices, all lines
    python tools/voice/build_voice.py --voices alan   # one voice (manifest is merged)
    python tools/voice/build_voice.py --lines intro_08,disc_web
    python tools/voice/verify_voice.py                # phonemes, ASR round-trip, loudness, spectrograms
    node   tools/voice/verify_browser.cjs             # decodeAudioData + narrator.js checks (Playwright)
    open   tools/voice/demo.html via `node tools/serve.mjs` to audition lines with captions

    Models (~63 MB + ~76 MB) are downloaded on first use into --work (default
    $XDG_CACHE_HOME/selah-voice, never the repo) from
      https://raw.githubusercontent.com/MycroftAI/mimic3-voices/master/voices/<model>/...
      https://media.githubusercontent.com/media/MycroftAI/mimic3-voices/master/voices/<model>/generator.onnx
    and checked against the sha256 pinned in script.json.  Use --models DIR to point at an
    existing `voices/` tree instead.

EDITING THE READ
    Wording lives in script.json and is art-directed (the build asserts phrases == text).
    Pacing: phrase `pause`, voice `length_scale`; steadiness: `noise_scale` / `noise_w`;
    pronunciation: `lexicon` or a phrase-level `say` respelling; tone: voice `eq`.

LICENCES (check before shipping!)
    en_UK/apope_low ships with the notice "Copyright 2022 Mycroft AI — All Rights Reserved";
    en_US/hifi-tts_low is trained on the Hi-Fi TTS dataset (NVIDIA, CC BY 4.0, attribution).
============================================================================================
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import time
import urllib.request
import zlib
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import mimic3_lite as m3  # noqa: E402

RAW_URL = "https://raw.githubusercontent.com/MycroftAI/mimic3-voices/master/voices"
LFS_URL = "https://media.githubusercontent.com/media/MycroftAI/mimic3-voices/master/voices"
SMALL_FILES = ["config.json", "phonemes.txt", "phoneme_map.txt", "speaker_map.csv", "LICENSE"]

HEAD_MARGIN = 0.020   # audio kept before the detected speech onset of a phrase (faded in)
TAIL_MARGIN = 0.060   # audio kept after the detected speech end of a phrase (faded out)
TRIM_REL_DB = -48.0   # speech = 10 ms frames louder than (loudest frame + TRIM_REL_DB)

# de-ess + light compression shared by all voices (EQ is per voice, see script.json)
DYNAMICS = "deesser=i=0.3:m=0.4:f=0.5:s=o,acompressor=threshold=0.0631:ratio=2:attack=15:release=220:knee=4"
MP3_ARGS = ["-c:a", "libmp3lame", "-q:a", "2", "-ac", "1"]


# ---------------------------------------------------------------------------- small utils

def log(*a):
    print(*a, flush=True)


def run(cmd: Sequence[str], capture: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(list(map(str, cmd)), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(map(str, cmd))}\n{proc.stderr.decode(errors='replace')[-2000:]}")
    return proc


def write_wav_f32(path: Path, x: np.ndarray, sr: int) -> None:
    """Minimal 32-bit float mono WAV writer (keeps the quiet raw model output un-quantised)."""
    data = np.asarray(x, dtype="<f4").tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 3, 1, sr, sr * 4, 4, 32)
    hdr += b"data" + struct.pack("<I", len(data))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(hdr + data)


def decode(path: Path, sr: Optional[int] = None) -> Tuple[np.ndarray, int]:
    """Decode any audio file to mono float32 via ffmpeg (native rate unless `sr` is given)."""
    if sr is None:
        out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path]).stdout
        sr = int(out.decode().strip().split("\n")[0])
    pcm = run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", sr, "-"]).stdout
    return np.frombuffer(pcm, dtype="<f4").copy(), sr


def frame_db(x: np.ndarray, sr: int, win: float = 0.01) -> np.ndarray:
    hop = max(1, int(round(sr * win)))
    n = len(x) // hop
    if n == 0:
        return np.full(1, -120.0)
    rms = np.sqrt(np.mean(x[: n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1))
    return 20.0 * np.log10(rms + 1e-9)


def speech_bounds(x: np.ndarray, sr: int, rel_db: float = TRIM_REL_DB) -> Tuple[int, int]:
    """First/last sample of speech (10 ms resolution)."""
    db = frame_db(x, sr)
    hop = max(1, int(round(sr * 0.01)))
    idx = np.where(db > db.max() + rel_db)[0]
    return int(idx[0] * hop), int(min(len(x), (idx[-1] + 1) * hop))


def trim_phrase(x: np.ndarray, sr: int) -> np.ndarray:
    """Cut a take down to its speech (+ margins) and fade the margins (never the speech)."""
    s, e = speech_bounds(x, sr)
    hm, tm = int(HEAD_MARGIN * sr), int(TAIL_MARGIN * sr)
    a, b = s - hm, e + tm
    seg = np.zeros(b - a, dtype=np.float32)
    lo, hi = max(a, 0), min(b, len(x))
    seg[lo - a: hi - a] = x[lo:hi]
    fin, fout = int(0.010 * sr), int(0.050 * sr)
    seg[:fin] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fin, dtype=np.float32))
    seg[-fout:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fout, dtype=np.float32))
    return seg


# ---------------------------------------------------------------------------- ASR (optional)

def norm_words(text: str) -> List[str]:
    text = text.lower().replace("-", " ").replace("\u2026", " ")
    text = re.sub(r"\(\d+\)", "", text)
    return re.sub(r"[^a-z' ]+", " ", text).split()


def word_errors(ref: List[str], hyp: List[str]) -> int:
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
            prev, d[j] = d[j], cur
    return d[-1]


def word_accuracy(ref_text: str, hyp_words: List[str]) -> float:
    ref = norm_words(ref_text)
    return max(0.0, 1.0 - word_errors(ref, hyp_words) / max(1, len(ref)))


def resample_16k(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == 16000:
        return x
    n = 95
    t = np.arange(n) - (n - 1) / 2
    fc = 0.5 * min(16000, sr) * 0.92 / sr
    h = 2 * fc * np.sinc(2 * fc * t) * np.hamming(n)
    y = np.convolve(x, h / h.sum(), mode="same")
    pos = np.arange(int(len(x) * 16000 / sr)) * (sr / 16000)
    return np.interp(pos, np.arange(len(y)), y).astype(np.float32)


class Asr:
    """PocketSphinx round-trip (weak recogniser — a relative signal, not ground truth)."""

    def __init__(self) -> None:
        from pocketsphinx import Decoder

        self.decoder = Decoder(samprate=16000, loglevel="FATAL")

    def transcribe(self, x: np.ndarray, sr: int) -> List[str]:
        y = resample_16k(x, sr)
        y = y / (np.abs(y).max() + 1e-9) * 0.7
        pcm = (y * 32767).astype("<i2").tobytes()
        self.decoder.start_utt()
        self.decoder.process_raw(pcm, full_utt=True)
        self.decoder.end_utt()
        hyp = self.decoder.hyp()
        return norm_words(hyp.hypstr) if hyp else []


def make_asr(enabled: bool) -> Optional[Asr]:
    if not enabled:
        return None
    try:
        return Asr()
    except Exception as exc:  # pocketsphinx missing or broken: selection falls back to duration
        log(f"  (ASR take scoring disabled: {exc})")
        return None


# ---------------------------------------------------------------------------- models

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ensure_model(models_root: Path, model: str, want_sha: Optional[str]) -> Path:
    vdir = models_root / model
    vdir.mkdir(parents=True, exist_ok=True)
    for name in SMALL_FILES:
        dst = vdir / name
        if dst.exists():
            continue
        try:
            with urllib.request.urlopen(f"{RAW_URL}/{model}/{name}", timeout=120) as r:
                dst.write_bytes(r.read())
        except Exception as exc:
            if name in ("config.json", "phonemes.txt"):
                raise RuntimeError(f"cannot fetch {model}/{name}: {exc}")
    onnx = vdir / "generator.onnx"
    if not onnx.exists():
        log(f"  downloading {model}/generator.onnx …")
        tmp = vdir / "generator.onnx.part"
        with urllib.request.urlopen(f"{LFS_URL}/{model}/generator.onnx", timeout=600) as r, open(tmp, "wb") as fh:
            for block in iter(lambda: r.read(1 << 20), b""):
                fh.write(block)
        tmp.rename(onnx)
    if want_sha:
        got = sha256(onnx)
        if got != want_sha:
            raise RuntimeError(f"{onnx}: sha256 {got} != pinned {want_sha}")
    return vdir


# ---------------------------------------------------------------------------- synthesis

def phrase_final(phrase: dict) -> str:
    if phrase.get("final"):
        return phrase["final"]
    last = phrase["text"].rstrip()[-1]
    if last in ".!?":
        return "major"
    if last in ",;:\u2026":
        return "minor"
    return "major"


def synth_phrase(vdir: Path, vcfg: dict, script: dict, line_id: str, pi: int, phrase: dict,
                 asr: Optional[Asr], takes: int) -> dict:
    """Synthesise N takes of one phrase and pick the best.  Returns audio + bookkeeping."""
    text = phrase.get("say") or phrase["text"]
    seed = zlib.crc32(f"{vcfg['model']}|{vcfg.get('speaker')}|{line_id}|{pi}|{text}".encode("utf-8")) & 0x7FFFFFFF
    voice = m3.Mimic3LiteVoice(vdir, seed=seed)
    words = m3.strip_breaks(m3.apply_word_overrides(voice.phonemize(text), script.get("lexicon")))
    final = phrase_final(phrase)
    seq = m3.with_final_break(words, final)
    missing = voice.unknown_phonemes(seq)
    if missing:
        raise RuntimeError(f"{line_id}[{pi}] phonemes not in the voice inventory: {missing}")
    ids = voice.phonemes_to_ids(seq)
    kw = dict(
        length_scale=float(phrase.get("length_scale", vcfg.get("length_scale", 1.2))),
        noise_scale=float(phrase.get("noise_scale", vcfg.get("noise_scale", 0.5))),
        noise_w=float(phrase.get("noise_w", vcfg.get("noise_w", 0.6))),
        speaker=vcfg.get("speaker"),
    )
    cands = []
    for t in range(takes):
        audio = voice.synthesize_ids(ids, **kw)
        s, e = speech_bounds(audio, voice.sample_rate)
        dur = (e - s) / voice.sample_rate
        hyp = asr.transcribe(audio[max(0, s - 2205): e + 2205], voice.sample_rate) if asr else []
        acc = word_accuracy(phrase["text"], hyp) if asr else 0.0
        cands.append(dict(take=t, audio=audio, dur=dur, acc=acc, hyp=" ".join(hyp), peak=float(np.abs(audio).max())))
    med = float(np.median([c["dur"] for c in cands]))
    for c in cands:  # lower is better: ASR errors first, then how unusual the pacing is
        c["score"] = (1.0 - c["acc"]) + 0.5 * abs(c["dur"] - med) / max(med, 1e-3) + (10.0 if c["peak"] >= 0.999 else 0.0)
    best = min(cands, key=lambda c: (round(c["score"], 6), c["take"]))
    return dict(
        audio=best["audio"], sr=voice.sample_rate, take=best["take"], seed=seed, final=final,
        phonemes=m3.describe(words), dur=best["dur"], acc=best["acc"], hyp=best["hyp"],
        takes=[dict(take=c["take"], dur=round(c["dur"], 3), acc=round(c["acc"], 3), hyp=c["hyp"]) for c in cands],
        params=kw,
    )


def assemble_line(script: dict, line: dict, phrases: List[dict]) -> Tuple[np.ndarray, int, List[dict]]:
    """Trimmed takes + designed pauses -> one line.  Returns audio, sr and exact caption times."""
    sr = phrases[0]["sr"]
    head, tail = float(script.get("head_room", 0.1)), float(script.get("tail_room", 0.12))
    parts: List[np.ndarray] = [np.zeros(max(0, int(round((head - HEAD_MARGIN) * sr))), dtype=np.float32)]
    caps: List[dict] = []
    pos = len(parts[0])
    for spec, ph in zip(line["phrases"], phrases):
        seg = trim_phrase(ph["audio"], sr)
        t0 = (pos + int(HEAD_MARGIN * sr)) / sr
        t1 = (pos + len(seg) - int(TAIL_MARGIN * sr)) / sr
        caps.append(dict(t0=t0, t1=t1, text=spec["text"]))
        parts.append(seg)
        pos += len(seg)
        if spec is not line["phrases"][-1]:
            gap = float(spec.get("pause", 0.8)) - TAIL_MARGIN - HEAD_MARGIN
            n = max(0, int(round(gap * sr)))
            parts.append(np.zeros(n, dtype=np.float32))
            pos += n
    parts.append(np.zeros(max(0, int(round((tail - TAIL_MARGIN) * sr))), dtype=np.float32))
    return np.concatenate(parts), sr, caps


# ---------------------------------------------------------------------------- mastering

def loudness(path: Path, chain: Optional[str] = None) -> Tuple[float, float]:
    """(integrated LUFS, true peak dBTP) of a file, optionally through a filter chain."""
    af = (chain + "," if chain else "") + "ebur128=peak=true"
    err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", af, "-f", "null", "-"]).stderr.decode(errors="replace")
    summary = err[err.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+|-inf|nan)\s+LUFS", summary)
    p = re.search(r"Peak:\s+(-?[\d.]+|-inf|nan)\s+dBFS", summary)
    return float(i.group(1)), float(p.group(1))


def master_line(pre: Path, out_wav: Path, out_mp3: Path, eq: str, target: float, ceiling_db: float) -> dict:
    """EQ -> de-ess -> compress -> loudness gain -> limiter -> MP3; iterate once on the result."""
    chain = f"{eq},{DYNAMICS}"
    measured, _ = loudness(pre, chain)
    gain = target - measured
    info = {}
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        limit = 10 ** (ceiling_db / 20)
        full = f"{chain},volume={gain:.3f}dB,alimiter=limit={limit:.4f}:attack=5:release=80:level=false"
        run(["ffmpeg", "-v", "error", "-y", "-i", pre, "-af", full, "-c:a", "pcm_s16le", out_wav])
        out_mp3.parent.mkdir(parents=True, exist_ok=True)
        run(["ffmpeg", "-v", "error", "-y", "-i", out_wav, *MP3_ARGS, "-map_metadata", "-1",
             "-id3v2_version", "0", "-write_id3v1", "0", "-flags", "+bitexact", "-fflags", "+bitexact", out_mp3])
        lufs, tp = loudness(out_mp3)
        info = dict(lufs=lufs, true_peak=tp, gain_db=round(gain, 2), passes=attempt + 1)
        if abs(lufs - target) <= 0.25:
            break
        gain += target - lufs
    return info


def measure_lag(ref: np.ndarray, out: np.ndarray, sr: int, max_lag: float = 0.12) -> float:
    """Delay (s) of `out` relative to `ref`, from the cross-correlation of 2 ms envelopes."""
    hop = max(1, int(sr * 0.002))

    def env(x):
        n = len(x) // hop
        return np.sqrt(np.mean(x[: n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1))

    a, b = env(ref), env(out)
    n = min(len(a), len(b))
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    m = int(max_lag / 0.002)
    best, best_lag = -1e30, 0
    for lag in range(-m, m + 1):
        v = float(np.dot(a[max(0, -lag): n - max(0, lag)], b[max(0, lag): n - max(0, -lag)]))
        if v > best:
            best, best_lag = v, lag
    return best_lag * hop / sr


# ---------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="Build Selah narration audio + manifest.")
    ap.add_argument("--script", default=str(HERE / "script.json"))
    ap.add_argument("--out", default=str(REPO / "assets" / "voice"))
    ap.add_argument("--work", default=os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "selah-voice"))
    ap.add_argument("--models", default=None, help="existing Mimic 3 `voices/` directory (default: <work>/models)")
    ap.add_argument("--voices", default=None, help="comma list (default: all in script.json)")
    ap.add_argument("--lines", default=None, help="comma list of line ids (default: all)")
    ap.add_argument("--takes", type=int, default=None, help="takes per phrase (default: per voice in script.json)")
    ap.add_argument("--no-asr", action="store_true", help="skip pocketsphinx scoring of takes")
    args = ap.parse_args()

    script = json.loads(Path(args.script).read_text(encoding="utf-8"))
    out_root, work = Path(args.out), Path(args.work)
    models_root = Path(args.models) if args.models else work / "models"
    voices = args.voices.split(",") if args.voices else list(script["voices"].keys())
    wanted = set(args.lines.split(",")) if args.lines else None
    target, ceiling = float(script.get("target_lufs", -19.0)), float(script.get("peak_ceiling_db", -3.0))

    for line in script["lines"]:  # the wording is art-directed: phrases must reproduce it exactly
        joined = " ".join(p["text"] for p in line["phrases"])
        if joined != line["text"]:
            raise SystemExit(f"{line['id']}: phrases do not reproduce the line text:\n  {joined!r}\n  {line['text']!r}")

    manifest_path = out_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"voices": {}}
    asr = make_asr(not args.no_asr)

    for vname in voices:
        vcfg = script["voices"][vname]
        log(f"== voice {vname}: {vcfg['model']}" + (f" speaker {vcfg['speaker']}" if vcfg.get("speaker") else ""))
        vdir = ensure_model(models_root, vcfg["model"], vcfg.get("sha256"))
        takes = args.takes or int(vcfg.get("takes", 5))
        vwork = work / "build" / vname
        entry = manifest["voices"].setdefault(vname, {"label": vcfg["label"], "lines": {}})
        entry["label"] = vcfg["label"]
        report = {}
        t_start = time.time()
        for line in script["lines"]:
            lid = line["id"]
            if wanted and lid not in wanted:
                continue
            phrases = [synth_phrase(vdir, vcfg, script, lid, i, p, asr, takes) for i, p in enumerate(line["phrases"])]
            audio, sr, caps = assemble_line(script, line, phrases)
            pre = vwork / "pre" / f"{lid}.wav"
            write_wav_f32(pre, audio, sr)
            mp3 = out_root / vname / f"{lid}.mp3"
            info = master_line(pre, vwork / "master" / f"{lid}.wav", mp3, vcfg["eq"], target, ceiling)

            # everything in the manifest is measured from the final MP3
            final, fsr = decode(mp3)
            lag = measure_lag(audio, final, sr) if fsr == sr else 0.0
            duration = len(final) / fsr
            captions = [dict(t0=round(c["t0"] + lag, 3), t1=round(min(c["t1"] + lag, duration), 3), text=c["text"]) for c in caps]
            entry["lines"][lid] = dict(file=f"{vname}/{lid}.mp3", duration=round(duration, 3), text=line["text"], captions=captions)
            report[lid] = dict(
                duration=round(duration, 3), lufs=info["lufs"], true_peak=info["true_peak"], gain_db=info["gain_db"],
                master_passes=info["passes"], lag_ms=round(lag * 1000, 1), bytes=mp3.stat().st_size, sample_rate=fsr,
                phrases=[dict(text=s["text"], final=p["final"], phonemes=p["phonemes"], take=p["take"], seed=p["seed"],
                              speech_s=round(p["dur"], 3), acc=round(p["acc"], 3), hyp=p["hyp"], takes=p["takes"], params=p["params"])
                         for s, p in zip(line["phrases"], phrases)],
            )
            log(f"  {lid:15s} {duration:6.2f}s  {info['lufs']:6.1f} LUFS  TP {info['true_peak']:5.1f}  {mp3.stat().st_size/1024:6.1f} kB  "
                f"takes {[p['take'] for p in phrases]}  lag {lag*1000:4.1f} ms")
        # keep manifest lines in script order
        order = [l["id"] for l in script["lines"]]
        entry["lines"] = {k: entry["lines"][k] for k in order if k in entry["lines"]}
        (vwork / "build_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
        total_s = sum(v["duration"] for v in entry["lines"].values())
        total_b = sum((out_root / v["file"]).stat().st_size for v in entry["lines"].values())
        log(f"  {vname}: {len(entry['lines'])} lines, {total_s:.1f} s, {total_b/1024:.0f} kB, built in {time.time()-t_start:.0f} s")

    manifest["default"] = script.get("default") if script.get("default") in manifest["voices"] else next(iter(manifest["voices"]))
    manifest = {"version": script.get("version", 1), "default": manifest["default"],
                "voices": {k: manifest["voices"][k] for k in script["voices"] if k in manifest["voices"]}}
    out_root.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
