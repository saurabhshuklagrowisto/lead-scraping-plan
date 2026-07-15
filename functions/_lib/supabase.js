// Shared Supabase client for Cloudflare Pages Functions.
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from Cloudflare Pages env vars
// (Settings -> Environment variables) — never hardcoded, never committed.
import { createClient } from "@supabase/supabase-js";

export function getSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set in Cloudflare Pages environment variables");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function errorJson(message, status = 400) {
  return json({ error: message }, status);
}
