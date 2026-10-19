// Validation and HubSpot field mapping for the public demo request form.
// Used by the local dev server and by the demo-request Lambda.

export const SEGMENTS = {
  hotel_group: 'Hotel group',
  shopping_centre: 'Shopping centre',
  facility_operator: 'Facility operator',
  waste_contractor: 'Waste contractor',
  other: 'Other',
};
const SITE_COUNTS = ['1–5', '6–15', '16–50', '51–150', '150+'];

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function validateDemoRequest(body = {}) {
  const value = {
    firstname: str(body.firstname, 80),
    lastname: str(body.lastname, 80),
    email: str(body.email, 254).toLowerCase(),
    company: str(body.company, 160),
    jobtitle: str(body.jobtitle, 120),
    segment: str(body.segment, 40),
    site_count: str(body.site_count, 20),
    message: str(body.message, 4000),
    plan_interest: str(body.plan_interest, 40),
    consent: body.consent === true,
    page: str(body.page, 200),
  };
  const errors = [];
  for (const k of ['firstname', 'lastname', 'email', 'company']) if (!value[k]) errors.push(`${k} is required`);
  if (value.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email)) errors.push('email is invalid');
  if (!SEGMENTS[value.segment]) errors.push('segment is invalid');
  if (!SITE_COUNTS.includes(value.site_count)) errors.push('site_count is invalid');
  if (!value.consent) errors.push('consent is required');
  return { ok: errors.length === 0, errors, value };
}

/** Maps a validated request to HubSpot contact properties. Custom properties are defined in docs/hubspot-crm-workflows.md. */
export function toHubSpotContact(v) {
  return {
    email: v.email,
    firstname: v.firstname,
    lastname: v.lastname,
    company: v.company,
    jobtitle: v.jobtitle,
    wl_segment: v.segment,
    wl_site_count_band: v.site_count,
    wl_plan_interest: v.plan_interest || undefined,
    wl_demo_request_message: v.message || undefined,
    wl_lead_source_detail: 'Website demo request form',
    lifecyclestage: 'lead',
  };
}
