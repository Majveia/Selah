#!/usr/bin/env python3
"""
mimic3_lite — a minimal, dependency-light re-implementation of Mycroft Mimic 3 inference.

Mimic 3 voices are VITS models exported to ONNX plus a few text files:

    <voice_dir>/generator.onnx     the model   (inputs: input, input_lengths, scales[, sid])
    <voice_dir>/config.json        training config (sample rate, phoneme options, language)
    <voice_dir>/phonemes.txt       "<id> <phoneme>" per line
    <voice_dir>/phoneme_map.txt    optional "<from> <to> [<to> ...]"   (e.g. "| ·", "‖ · ·")
    <voice_dir>/speaker_map.csv    optional "id|dataset|name[|alias...]" for multi-speaker models

The official `mycroft-mimic3-tts` package pins old dependencies (numpy<2, epitran, espeak
bindings, ...) and is awkward on current Pythons, so this file ports just the part we need:

    text --gruut--> words/phonemes --(phonemes2ids rules)--> ids --onnxruntime--> float PCM

The id rules are a faithful port of `phonemes2ids.phonemes2ids()` for the options used by the
Mimic 3 English voices (bos/eos, blank between tokens *and* words, stress marks separated out,
simple punctuation, phoneme_map).  `tools/voice/verify_voice.py --selftest` cross-checks this
port against the real `phonemes2ids` package when it is installed.

Only needs: numpy, onnxruntime, gruut (English is bundled with gruut).
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

# Default punctuation simplification used by phonemes2ids when `simple_punctuation` is on.
PUNCTUATION_MAP = {";": ",", ":": ",", "?": ".", "!": "."}

# gruut break symbols (IPA): minor break (comma-like) and major break (sentence end).
BREAK_MINOR = "|"
BREAK_MAJOR = "‖"  # ‖

VOWELS = {
    "aɪ", "aʊ", "eɪ", "i", "oʊ", "u", "æ", "ɑ", "ɔ", "ɔɪ", "ə", "ɚ", "ɛ", "ɪ", "ʊ", "ʌ",
}


@dataclass
class Word:
    """One token of a phrase: its text and its phonemes (stress marks still attached)."""

    text: str
    phonemes: List[str] = field(default_factory=list)
    is_break: bool = False

    def __str__(self) -> str:  # pragma: no cover - debugging helper
        return f"{self.text}[{' '.join(self.phonemes)}]"


def load_phoneme_ids(path: Path) -> Dict[str, int]:
    """phonemes.txt: `<id><space><phoneme>` per line; `#` comments (but `4 #` is a phoneme)."""
    out: Dict[str, int] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip("\r\n")
            if (not line) or line.startswith("#") or (" " not in line):
                continue
            pid, phoneme = line.split(" ", maxsplit=1)
            out[phoneme] = int(pid)
    return out


def load_phoneme_map(path: Path) -> Dict[str, List[str]]:
    """phoneme_map.txt: `<from><space><to> [<to> ...]` per line."""
    out: Dict[str, List[str]] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip("\r\n")
            if (not line) or line.startswith("#") or (" " not in line):
                continue
            src, dst = line.split(" ", maxsplit=1)
            out[src] = dst.split() if dst.strip() else [" "]
    return out


class Mimic3LiteVoice:
    """A loaded Mimic 3 voice.  One instance == one onnxruntime session."""

    def __init__(
        self,
        voice_dir: os.PathLike | str,
        seed: Optional[int] = None,
        threads: int = 1,
    ) -> None:
        import onnxruntime as ort

        self.voice_dir = Path(voice_dir)
        with open(self.voice_dir / "config.json", "r", encoding="utf-8") as fh:
            self.config = json.load(fh)

        self.sample_rate: int = int(self.config["audio"]["sample_rate"])
        self.text_language: str = self.config.get("text_language") or "en_US"
        self.phonemes_cfg: dict = self.config["phonemes"]
        self.inference_cfg: dict = self.config.get("inference") or {}
        self.n_speakers: int = int(self.config["model"].get("n_speakers", 1))

        phonemizer = self.config.get("phonemizer", "gruut")
        if phonemizer != "gruut":
            raise ValueError(f"mimic3_lite only supports gruut voices (got {phonemizer!r})")

        self.phoneme_to_id = load_phoneme_ids(self.voice_dir / "phonemes.txt")
        map_path = self.voice_dir / "phoneme_map.txt"
        self.phoneme_map = load_phoneme_map(map_path) if map_path.is_file() else {}

        self.speaker_map: Dict[str, int] = {}
        spk_path = self.voice_dir / "speaker_map.csv"
        if spk_path.is_file():
            with open(spk_path, "r", encoding="utf-8") as fh:
                for row in csv.reader(fh, delimiter="|"):
                    if len(row) >= 3:
                        for alias in row[2:]:
                            self.speaker_map[alias] = int(row[0])

        # The VITS graph contains RandomNormalLike ops (prior noise + stochastic duration
        # predictor).  onnxruntime seeds those kernels when the *session is created*, from the
        # global seed, so: set the seed, then build the session.  Runs are then a deterministic
        # sequence as long as they happen in the same order with the same inputs.
        self.seed = seed
        if seed is not None:
            ort.set_seed(int(seed))
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(threads)
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(
            str(self.voice_dir / "generator.onnx"),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self._input_names = {i.name for i in self.session.get_inputs()}

    # ------------------------------------------------------------------ text -> phonemes

    def phonemize(self, text: str) -> List[Word]:
        """gruut text -> list of Word (punctuation breaks come back as `|` / `‖` words)."""
        import gruut

        words: List[Word] = []
        for sentence in gruut.sentences(text, lang=self.text_language):
            for w in sentence:
                if not w.phonemes:
                    continue
                phonemes = [p for p in w.phonemes if p]
                is_break = all(p in (BREAK_MINOR, BREAK_MAJOR) for p in phonemes)
                words.append(Word(text=w.text, phonemes=phonemes, is_break=is_break))
        return words

    # ------------------------------------------------------------------ phonemes -> ids

    def phonemes_to_ids(self, word_phonemes: Sequence[Sequence[str]]) -> List[int]:
        """Port of phonemes2ids.phonemes2ids() (see module docstring)."""
        cfg = self.phonemes_cfg
        p2i = self.phoneme_to_id
        separate = set(cfg.get("separate") or [])
        simple_punct = bool(cfg.get("simple_punctuation", False))
        punct_map = cfg.get("punctuation_map") or PUNCTUATION_MAP
        phoneme_map = self.phoneme_map or (cfg.get("phoneme_map") or {})
        blank = cfg.get("blank")
        blank_word = cfg.get("blank_word")
        blank_between = cfg.get("blank_between", "words")
        blank_at_start = bool(cfg.get("blank_at_start", True))
        blank_at_end = bool(cfg.get("blank_at_end", True))
        auto_bos_eos = bool(cfg.get("auto_bos_eos", False))
        bos, eos = cfg.get("bos"), cfg.get("eos")

        blank_id = p2i[blank] if blank else None
        blank_word_id = p2i[blank_word] if blank_word else blank_id

        out: List[int] = []
        if bos and auto_bos_eos and bos in p2i:
            out.append(p2i[bos])
        if blank_id is not None and blank_at_start:
            out.append(blank_id)

        last = len(word_phonemes) - 1
        for idx, word in enumerate(word_phonemes):
            ids: List[int] = []
            for phoneme in word:
                # split stress marks (ˈ ˌ) out into their own tokens
                subs: List[str] = []
                if separate:
                    acc = ""
                    for ch in phoneme:
                        if ch in separate:
                            if acc:
                                subs.append(acc)
                                acc = ""
                            subs.append(ch)
                        else:
                            acc += ch
                    if acc:
                        subs.append(acc)
                else:
                    subs = [phoneme]
                for sub in subs:
                    if not sub:
                        continue
                    if simple_punct and punct_map:
                        sub = punct_map.get(sub, sub)
                    for target in phoneme_map.get(sub) or [sub]:
                        pid = p2i.get(target)
                        if pid is not None:  # unknown phonemes are dropped (fail_on_missing=False)
                            ids.append(pid)
            if not ids:
                continue
            if blank_word_id is not None and blank_between in ("words", "tokens_and_words"):
                if idx != last or blank_at_end:
                    ids.append(blank_word_id)
            if blank_id is not None and blank_between in ("tokens", "tokens_and_words"):
                inter: List[int] = []
                for pid in ids:
                    inter.extend((pid, blank_id))
                if idx == last and not blank_at_end and inter:
                    inter.pop()
                ids = inter
            out.extend(ids)

        if eos and auto_bos_eos and eos in p2i:
            out.append(p2i[eos])
        return out

    def unknown_phonemes(self, word_phonemes: Iterable[Iterable[str]]) -> List[str]:
        """Phonemes that would be silently dropped by phonemes_to_ids (should be empty)."""
        separate = set(self.phonemes_cfg.get("separate") or [])
        punct_map = self.phonemes_cfg.get("punctuation_map") or PUNCTUATION_MAP
        missing = []
        for word in word_phonemes:
            for phoneme in word:
                core = "".join(ch for ch in phoneme if ch not in separate)
                core = punct_map.get(core, core)
                for target in self.phoneme_map.get(core) or [core]:
                    if target and target not in self.phoneme_to_id:
                        missing.append(phoneme)
        return missing

    # ------------------------------------------------------------------ ids -> audio

    def speaker_id(self, speaker: Optional[str | int]) -> int:
        if speaker is None:
            return 0
        if isinstance(speaker, int):
            return speaker
        if speaker in self.speaker_map:
            return self.speaker_map[speaker]
        return int(speaker)

    def synthesize_ids(
        self,
        ids: Sequence[int],
        length_scale: Optional[float] = None,
        noise_scale: Optional[float] = None,
        noise_w: Optional[float] = None,
        speaker: Optional[str | int] = None,
    ) -> np.ndarray:
        """Run the generator.  Returns mono float32 PCM in [-1, 1] at self.sample_rate.

        NOTE: unlike Mimic 3's CLI we do NOT peak-normalise each utterance here — levels are
        handled by the mastering stage so that takes stay comparable.
        """
        inf = self.inference_cfg
        ls = float(length_scale if length_scale is not None else inf.get("length_scale", 1.0))
        ns = float(noise_scale if noise_scale is not None else inf.get("noise_scale", 0.667))
        nw = float(noise_w if noise_w is not None else inf.get("noise_w", 0.8))
        arr = np.asarray(ids, dtype=np.int64)[None, :]
        feeds = {
            "input": arr,
            "input_lengths": np.asarray([arr.shape[1]], dtype=np.int64),
            "scales": np.asarray([ns, ls, nw], dtype=np.float32),
        }
        if "sid" in self._input_names:
            feeds["sid"] = np.asarray([self.speaker_id(speaker)], dtype=np.int64)
        audio = self.session.run(None, feeds)[0]
        return np.asarray(audio, dtype=np.float32).reshape(-1)


def apply_word_overrides(
    words: List[Word],
    lexicon: Optional[Dict[str, Sequence[str]]] = None,
    the_before_vowel: bool = True,
) -> List[Word]:
    """Pronunciation fixes applied after gruut:

    * `lexicon`: {"selah": ["s", "ˈeɪ", "l", "ɑ"], ...}  (keys are lower-cased word text)
    * "the" before a vowel sound -> /ði/ ("thee old songs"), which gruut's lexicon never does.
    """
    lex = {k.lower(): list(v) for k, v in (lexicon or {}).items()}
    out = [Word(w.text, list(w.phonemes), w.is_break) for w in words]
    for w in out:
        key = w.text.lower().strip(".,;:!?…'\"")
        if key in lex:
            w.phonemes = list(lex[key])
    if the_before_vowel:
        for i, w in enumerate(out[:-1]):
            if w.text.lower() != "the":
                continue
            nxt = out[i + 1]
            if nxt.is_break or not nxt.phonemes:
                continue
            first = nxt.phonemes[0].lstrip("ˈˌ")
            if first in VOWELS:
                w.phonemes = ["ð", "i"]
    return out


def strip_breaks(words: List[Word], keep_inner: bool = True) -> List[Word]:
    """Drop trailing (and leading) break tokens; optionally drop the inner ones as well."""
    out = list(words)
    while out and out[-1].is_break:
        out.pop()
    while out and out[0].is_break:
        out.pop(0)
    if not keep_inner:
        out = [w for w in out if not w.is_break]
    return out


def with_final_break(words: List[Word], final: str) -> List[List[str]]:
    """Word phonemes for the model, ending with the requested boundary:

    "major" -> ‖ (sentence end, falling),  "minor" -> | (comma, continuing),  "none" -> nothing
    """
    seq = [list(w.phonemes) for w in words]
    if final == "major":
        seq.append([BREAK_MAJOR])
    elif final == "minor":
        seq.append([BREAK_MINOR])
    elif final != "none":
        raise ValueError(f"unknown final break {final!r}")
    return seq


def describe(words: List[Word]) -> str:
    """Human-readable phoneme string, e.g. `Selah[s ˈeɪ l ɑ]`."""
    return " ".join(f"{w.text}[{' '.join(w.phonemes)}]" for w in words)
