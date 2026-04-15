import path from 'node:path';
import { Pipeline } from './pipeline.js';
import { createServer, GUI_PORT } from './server.js';
import { migrateLegacyDataIfNeeded } from './recognition/whisper-setup.js';

migrateLegacyDataIfNeeded();

const configPath = process.argv[2] ?? path.join(process.cwd(), 'config.toml');
const pipeline = new Pipeline(configPath);

const server = createServer({ pipeline });
server.on('error', (err) => {
  console.error(`[GUI] Server error: ${err.message}`);
  process.exit(1);
});
server.listen(GUI_PORT, '127.0.0.1', () => {
  console.log(`[GUI] http://127.0.0.1:${GUI_PORT}/`);
});

pipeline.start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

function shutdown() {
  console.log('\nShutting down...');
  pipeline.stop().then(() => {
    server.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
