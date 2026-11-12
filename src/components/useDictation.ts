"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings for the browser speech API (not in TypeScript's lib.dom).
type Alt = { transcript: string };
type Res = { isFinal: boolean; length: number; [i: number]: Alt };
type RecEvent = { resultIndex: number; results: { length: number; [i: number]: Res } };
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecCtor = new () => Rec;

function getCtor(): RecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow the mic for this site in your browser settings, then tap the mic again.",
  "service-not-allowed": "Microphone access is blocked. Allow the mic for this site in your browser settings, then tap the mic again.",
  "audio-capture": "No microphone was found.",
  "no-speech": "Didn't hear anything. Tap the mic to try again.",
  network: "Dictation needs an internet connection.",
};

// Voice dictation into a text box. It ONLY writes text into the box via setValue; it never sends
// anything. The words are appended to whatever was already typed. If the user types or the box is
// cleared (e.g. after Send) while listening, dictation stops so it can't overwrite their edit.
export function useDictation(value: string, setValue: (v: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recRef = useRef<Rec | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;
  const written = useRef<Set<string>>(new Set());

  useEffect(() => {
    setSupported(!!getCtor());
    return () => {
      const rec = recRef.current;
      if (rec) {
        rec.onresult = rec.onerror = rec.onend = null;
        try { rec.abort(); } catch {}
        recRef.current = null;
      }
    };
  }, []);

  // Stop (and ignore late results) when the box changed by something other than dictation.
  useEffect(() => {
    const rec = recRef.current;
    if (rec && !written.current.has(value)) {
      rec.onresult = null;
      try { rec.stop(); } catch {}
      recRef.current = null;
      setListening(false);
    }
  }, [value]);

  const toggle = useCallback(() => {
    const active = recRef.current;
    if (active) {
      try { active.stop(); } catch {}
      setListening(false);
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;
    setError("");
    const rec = new Ctor();
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    const typed = valueRef.current;
    const base = typed && !/\s$/.test(typed) ? typed + " " : typed;
    written.current = new Set();
    rec.onresult = (e) => {
      const pieces: string[] = [];
      for (let i = 0; i < e.results.length; i++) {
        const t = (e.results[i][0]?.transcript ?? "").trim();
        if (t) pieces.push(t);
      }
      const text = base + pieces.join(" ");
      written.current.add(text);
      setValueRef.current(text);
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      setError(ERRORS[e.error] || "Dictation stopped unexpectedly. Tap the mic to try again.");
    };
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      setError("Couldn't start dictation. Tap the mic to try again.");
    }
  }, []);

  return { supported, listening, error, toggle };
}
