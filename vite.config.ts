import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const prefix=(process.env.OPENCAST_BASE_PATH||'').replace(/\/+$/,'');
export default defineConfig({plugins:[react(),tailwindcss()],base:prefix+'/',server:{proxy:{[`${prefix}/api`]:{target:process.env.OPENCAST_DEV_API||'http://127.0.0.1:8389'}}}});
