import { verifyJournalFile, formatChainMessage } from "./journal.js";

const file = process.argv[2];
if (!file || file.startsWith("-")) {
  console.error("Usage: node dist/verify-journal.js <fichier.jsonl>");
  process.exit(2);
}

try {
  const result = await verifyJournalFile(file);
  const msg = formatChainMessage(result);
  if (result.ok) {
    console.log(msg);
    process.exit(0);
  } else {
    console.error(msg);
    process.exit(1);
  }
} catch (e) {
  const err = e instanceof Error ? e.message : String(e);
  console.error("Impossible de lire le journal : " + err);
  process.exit(2);
}
