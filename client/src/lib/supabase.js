import { createClient } from "@supabase/supabase-js";
import { APP_ENV } from "./env";

const supabaseUrl = APP_ENV.supabaseUrl;
const supabaseAnonKey = APP_ENV.supabaseAnonKey;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
