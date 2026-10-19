// Integration check for the review store against a real PostgreSQL loaded with db/schema.sql and db/seed-demo.sql.
//   DATABASE_URL=postgres://… node scripts/review-db-check.mjs
import assert from 'node:assert/strict';
import { buildPortfolio, buildReviewQueue } from '../core/demo-data.js';
import { getPool, closePool } from '../backend/lib/db.js';
import { listQueue, saveFieldReviews, previewAccept, accept, reject } from '../backend/lib/review-store.js';

const ORG = 'ORG-CVE';
const REVIEWER = 'reviewer@example.test';
const db = await getPool();
const q = (sql, p) => db.query(sql, p).then((r) => r.rows);

// Load the demo review queue as if the ingest Lambda had just processed it.
const data = buildPortfolio();
for (const d of buildReviewQueue(data).filter((x) => !x.inRegister)) {
  await q(`INSERT INTO documents (id, org_id, s3_bucket, s3_key, sha256, doc_type, classified_by, classification_confidence, state, file_name)
    VALUES ($1,$2,'demo',$3,'x',$4,'bedrock',$5,$6,$7)`, [d.documentId, ORG, `incoming/${ORG}/${d.fileName}`, d.docType, d.classificationConfidence, d.state, d.fileName]);
  for (const f of d.fields) await q('INSERT INTO extracted_fields (document_id, field_key, field_label, raw_value, confidence) VALUES ($1,$2,$3,$4,$5)', [d.documentId, f.key, f.label, f.value, f.confidence]);
}

// 1. The trigger refuses records from a document that has not been accepted.
await assert.rejects(q(`INSERT INTO collection_tickets (id, ticket_no, site_id, provider_id, service_code, stream, collected_on, containers, status, document_id, source)
  VALUES ('X','NG-1','SITE-LDS','PRV-NGW','GW-1100-LIFT','General waste','2026-09-21',2,'collected','DOC-TKT-NG-558309','textract')`), /has not been accepted/);
console.log('✓ trigger blocks records from unaccepted documents');

const queue = await listQueue(ORG);
assert.equal(queue.length, 4);
console.log(`✓ queue lists ${queue.length} documents`);

// 2. Accept is refused while a low-confidence field is unreviewed.
const c = { siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 2 };
await assert.rejects(accept(ORG, 'DOC-TKT-NG-558309', c, REVIEWER), (e) => e.status === 422 && /71% confidence/.test(e.message));
console.log('✓ accept refused before field review');

// 3. Review, preview, accept.
const reviewed = await saveFieldReviews(ORG, 'DOC-TKT-NG-558309', { containers: { confirm: true } }, REVIEWER);
assert.equal(reviewed.reviewState, 'extracted');
assert.equal((await previewAccept(ORG, 'DOC-TKT-NG-558309', c)).ok, true);
await accept(ORG, 'DOC-TKT-NG-558309', c, REVIEWER);
const [t] = await q("SELECT * FROM collection_tickets WHERE document_id = 'DOC-TKT-NG-558309'");
assert.equal(t.containers, 2);
assert.equal(t.status, 'collected');
const [doc] = await q("SELECT state, reviewed_by FROM documents WHERE id = 'DOC-TKT-NG-558309'");
assert.deepEqual(doc, { state: 'accepted', reviewed_by: REVIEWER });
const [f] = await q("SELECT reviewed_by FROM extracted_fields WHERE document_id = 'DOC-TKT-NG-558309' AND field_key = 'containers'");
assert.equal(f.reviewed_by, REVIEWER);
console.log('✓ reviewed ticket accepted into collection_tickets with its document_id');

// 4. Weighbridge slip → verified weight.
await accept(ORG, 'DOC-WB-NG-558309', { siteId: 'SITE-LDS', providerId: 'PRV-NGW', stream: 'General waste' }, REVIEWER);
const [w] = await q("SELECT basis, net_kg FROM weight_records_with_basis WHERE document_id = 'DOC-WB-NG-558309'");
assert.deepEqual({ basis: w.basis, net: Number(w.net_kg) }, { basis: 'verified', net: 415 });
console.log('✓ weighbridge slip accepted as a verified weight');

// 5. Accepting twice is refused.
await assert.rejects(accept(ORG, 'DOC-WB-NG-558309', { siteId: 'SITE-LDS', providerId: 'PRV-NGW', stream: 'General waste' }, REVIEWER), (e) => e.status === 409);
console.log('✓ second accept refused');

// 6. Corrected date, then reject needs a reason.
await saveFieldReviews(ORG, 'DOC-TKT-NG-558298', { date: { value: '16/09/2026' } }, REVIEWER);
await accept(ORG, 'DOC-TKT-NG-558298', { siteId: 'SITE-SHF', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 4 }, REVIEWER);
await assert.rejects(reject(ORG, 'DOC-UPL-0931', '', REVIEWER), (e) => e.status === 422);
await reject(ORG, 'DOC-UPL-0931', 'Not a waste document', REVIEWER);
const audit = await q("SELECT action, count(*)::int AS n FROM document_reviews GROUP BY 1 ORDER BY 1");
console.log('✓ corrected ticket accepted, photo rejected. Audit:', JSON.stringify(audit));
assert.equal((await listQueue(ORG)).length, 0);
console.log('✓ queue empty');
await closePool();
