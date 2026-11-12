import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

// Turns a recorded meeting's audio into text. Engines, best first:
//  1. OpenAI Whisper API, when OPENAI_API_KEY is set (best accuracy, hears everyone in the mix).
//  2. Local whisper.cpp (`brew install whisper-cpp ffmpeg`), when WHISPER_MODEL points at a
//     ggml model file. Fully offline.
//  3. Neither: the live transcript the browser made while recording (Web Speech API) is used.

export type Engine = "openai" | "local" | "browser";

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const OPENAI_LIMIT = 24 * 1024 * 1024;

async function has(bin: string) {
  try {
    await run("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

export async function availableEngine(): Promise<Engine> {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL) && (await has(WHISPER_BIN)) && (await has("ffmpeg"))) return "local";
  return "browser";
}

/** Split long audio into ~20 minute mono mp3 pieces (needs ffmpeg), so each fits the API limit. */
async function splitForApi(file: string): Promise<string[]> {
  if (fs.statSync(file).size <= OPENAI_LIMIT) return [file];
  if (!(await has("ffmpeg"))) throw new Error("Recording is over 24 MB and ffmpeg isn't installed to split it (brew install ffmpeg)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-"));
  await run("ffmpeg", ["-y", "-i", file, "-ac", "1", "-b:a", "48k", "-f", "segment", "-segment_time", "1200", path.join(dir, "part%03d.mp3")]);
  return fs.readdirSync(dir).sort().map((f) => path.join(dir, f));
}

async function viaOpenAI(file: string, mime: string): Promise<string> {
  const parts = await splitForApi(file);
  const texts: string[] = [];
  for (const part of parts) {
    const form = new FormData();
    const type = part === file ? mime : "audio/mpeg";
    form.set("file", new Blob([fs.readFileSync(part)], { type }), path.basename(part));
    form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    texts.push(((await res.json()).text || "").trim());
  }
  return texts.join("\n\n");
}

async function viaLocal(file: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-"));
  const wav = path.join(dir, "audio.wav");
  await run("ffmpeg", ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { maxBuffer: 1 << 26 });
  const outBase = path.join(dir, "out");
  await run(WHISPER_BIN, ["-m", process.env.WHISPER_MODEL!, "-f", wav, "-otxt", "-of", outBase], { maxBuffer: 1 << 26, timeout: 60 * 60_000 });
  return fs.readFileSync(`${outBase}.txt`, "utf8").trim();
}

export async function transcribeFile(file: string, mime: string): Promise<{ text: string; engine: Engine } | null> {
  const engine = await availableEngine();
  if (engine === "openai") return { text: await viaOpenAI(file, mime), engine };
  if (engine === "local") return { text: await viaLocal(file), engine };
  return null;
}
