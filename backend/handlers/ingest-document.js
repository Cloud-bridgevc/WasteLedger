// S3 ObjectCreated → classify → extract → store fields → route to review or acceptance.
// Key layout: incoming/<orgId>/<anything>.pdf. Records are only written to the operational tables once
// every field that matters clears the confidence threshold or a reviewer has confirmed it.

import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import { classifyDocument } from '../lib/bedrock.js';
import { extractInvoice, extractByQueries, firstLines } from '../lib/textract.js';
import { getPool } from '../lib/db.js';

const s3 = new S3Client({});
const textract = new TextractClient({});
const REVIEW_THRESHOLD = Number(process.env.REVIEW_THRESHOLD || 0.9);
const CLASSIFY_THRESHOLD = Number(process.env.CLASSIFY_THRESHOLD || 0.8);

async function sha256Of(bucket, key, versionId) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const hash = createHash('sha256');
  for await (const chunk of obj.Body) hash.update(chunk);
  return hash.digest('hex');
}

export async function handler(event) {
  const db = await getPool();
  for (const rec of event.Records || []) {
    const bucket = rec.s3.bucket.name;
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
    const versionId = rec.s3.object.versionId;
    const [, orgId] = key.split('/');
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    const docId = head.Metadata?.['document-id'] || `DOC-${createHash('sha1').update(`${bucket}/${key}/${versionId}`).digest('hex').slice(0, 12).toUpperCase()}`;
    const sha256 = await sha256Of(bucket, key, versionId);

    await db.query(`INSERT INTO documents (id, org_id, s3_bucket, s3_key, s3_version_id, sha256) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [docId, orgId, bucket, key, versionId, sha256]);

    // 1. Classify from first-page text (synchronous detection works on single-page images and PDFs).
    const detected = await textract.send(new DetectDocumentTextCommand({ Document: { S3Object: { Bucket: bucket, Name: key, Version: versionId } } }));
    const cls = await classifyDocument({ firstPageText: firstLines(detected.Blocks || []), fileName: key.split('/').pop() });
    await db.query('UPDATE documents SET doc_type = $2, classified_by = $3, classification_confidence = $4 WHERE id = $1', [docId, cls.docType, `bedrock:${cls.model}`, cls.confidence]);

    if (cls.confidence < CLASSIFY_THRESHOLD || cls.docType === 'other' || cls.docType === 'contract' || cls.docType === 'disposal_note') {
      // Contracts and disposal notes are filed for reference and reviewed by a person. Rates are never auto-loaded.
      await db.query("UPDATE documents SET state = 'needs_review' WHERE id = $1", [docId]);
      console.log(JSON.stringify({ msg: 'document needs review', docId, ...cls }));
      continue;
    }

    // 2. Extract fields.
    const out = cls.docType === 'invoice'
      ? await extractInvoice({ bucket, key })
      : await extractByQueries({ bucket, key, docType: cls.docType });

    for (const f of out.fields) {
      await db.query('INSERT INTO extracted_fields (document_id, field_key, field_label, raw_value, confidence, page, bbox) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [docId, f.key, f.label, f.value, f.confidence, f.page ?? null, f.bbox ? JSON.stringify(f.bbox) : null]);
    }
    const lowLines = (out.lines || []).some((l) => Object.values(l).some((c) => c.confidence < REVIEW_THRESHOLD));
    const needsReview = lowLines || out.fields.some((f) => f.confidence < REVIEW_THRESHOLD);
    await db.query('UPDATE documents SET state = $2, textract_job = $3 WHERE id = $1', [docId, needsReview ? 'needs_review' : 'extracted', out.jobId]);
    console.log(JSON.stringify({ msg: 'document extracted', docId, docType: cls.docType, fields: out.fields.length, needsReview }));
    // Accepted documents are mapped to collection_tickets / weight_records / invoices by the review service
    // after a person confirms the site and provider match. This keeps a misread site name from
    // attaching a charge to the wrong location.
  }
}
