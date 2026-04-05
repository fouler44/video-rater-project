function requiredEnv(name) {
  const value = String(import.meta.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const APP_ENV = {
  apiBaseUrl: requiredEnv("VITE_API_BASE_URL"),
  supabaseUrl: requiredEnv("VITE_SUPABASE_URL"),
  supabaseAnonKey: requiredEnv("VITE_SUPABASE_ANON_KEY"),
  partykitUrl: requiredEnv("VITE_PARTYKIT_URL"),
};
