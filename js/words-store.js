/**
 * Личная библиотека слов: localStorage + опционально Supabase (RLS).
 */
const STORAGE_KEY = "sfumato_words_v2";
const MAX_WORDS = 60;

let client = null;
let configured = false;

function rowsToRaw(rows) {
  return rows.map(r => `${r.category} / ${r.detail}`).join("\n");
}

export function parseWords(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const i = line.indexOf("/");
      if (i < 0) return { category: "sense", detail: line.slice(0, 80) };
      return {
        category: line.slice(0, i).trim().slice(0, 48) || "sense",
        detail: line.slice(i + 1).trim().slice(0, 80),
      };
    })
    .filter(w => w.detail.length >= 2);
}

export async function initWordsStore() {
  try {
    const cfg = await import("../config.js");
    if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
      client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      configured = true;
      await ensureSession();
    }
  } catch {
    configured = false;
  }
}

export function isCloudEnabled() {
  return configured && !!client;
}

async function ensureSession() {
  if (!client) return;
  const { data: { session } } = await client.auth.getSession();
  if (!session) await client.auth.signInAnonymously();
}

export function loadLocalRaw(fallback) {
  return localStorage.getItem(STORAGE_KEY) || fallback;
}

function saveLocalRaw(raw) {
  localStorage.setItem(STORAGE_KEY, raw);
}

export async function loadLibraryRaw(fallbackRaw) {
  let raw = loadLocalRaw(fallbackRaw);
  if (!client) return raw;
  try {
    await ensureSession();
    const { data, error } = await client
      .from("words")
      .select("category, detail, created_at")
      .order("created_at", { ascending: true });
    if (error) throw error;
    if (data?.length) {
      raw = rowsToRaw(data);
      saveLocalRaw(raw);
    }
  } catch (err) {
    console.warn("words cloud load", err);
  }
  return raw;
}

export async function replaceLibraryRaw(raw) {
  const parsed = parseWords(raw).slice(0, MAX_WORDS);
  const normalized = rowsToRaw(parsed);
  saveLocalRaw(normalized);
  if (!client) return normalized;
  try {
    await ensureSession();
    const uid = (await client.auth.getUser()).data.user?.id;
    if (!uid) return normalized;
    await client.from("words").delete().eq("user_id", uid);
    if (parsed.length) {
      const { error } = await client.from("words").insert(
        parsed.map(w => ({ category: w.category, detail: w.detail })),
      );
      if (error) throw error;
    }
  } catch (err) {
    console.warn("words cloud replace", err);
  }
  return normalized;
}

export async function addWord(category, detail) {
  const cat = (category || "sense").trim().slice(0, 48);
  const det = detail.trim().slice(0, 80);
  if (det.length < 2) return null;
  const raw = loadLocalRaw("");
  const parsed = parseWords(raw);
  if (parsed.some(w => w.detail.toLowerCase() === det.toLowerCase())) return null;
  if (parsed.length >= MAX_WORDS) return null;
  parsed.push({ category: cat, detail: det });
  const normalized = rowsToRaw(parsed);
  saveLocalRaw(normalized);
  if (client) {
    try {
      await ensureSession();
      const uid = (await client.auth.getUser()).data.user?.id;
      if (uid) {
        await client.from("words").insert({ category: cat, detail: det });
      }
    } catch (err) {
      console.warn("words cloud add", err);
    }
  }
  return normalized;
}

export async function deleteWordAt(index, currentRaw) {
  const parsed = parseWords(currentRaw);
  if (index < 0 || index >= parsed.length) return currentRaw;
  const removed = parsed.splice(index, 1)[0];
  const normalized = rowsToRaw(parsed);
  saveLocalRaw(normalized);
  if (client && removed) {
    try {
      await ensureSession();
      const uid = (await client.auth.getUser()).data.user?.id;
      if (uid) {
        await client
          .from("words")
          .delete()
          .eq("user_id", uid)
          .eq("category", removed.category)
          .eq("detail", removed.detail);
      }
    } catch (err) {
      console.warn("words cloud delete", err);
    }
  }
  return normalized;
}

export async function linkEmail(email) {
  if (!client) throw new Error("Cloud not configured");
  await ensureSession();
  const { error } = await client.auth.updateUser({ email });
  if (error) throw error;
}
