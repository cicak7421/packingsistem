const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di environment variables.');
}

// Pakai service role key (bukan anon key) karena ini jalan di server (backend),
// bukan di browser. Service role otomatis bypass Row Level Security.
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

module.exports = supabase;
