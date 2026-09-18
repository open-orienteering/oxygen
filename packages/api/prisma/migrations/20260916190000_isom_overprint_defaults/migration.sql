-- Align overprint appearance defaults with ISOM 2017-2:
--  * purple: sRGB equivalent of offset CMYK 35-85-0-0 / PMS Purple
--    (Appendix 1) instead of the earlier Tailwind fuchsia pick;
--  * control numbers: 4.0 mm digit height (symbol 704) instead of 3.5 mm.
-- Only rows still carrying the old defaults are touched — customised
-- values are the user's choice and stay as they are.

UPDATE oxygen.map_templates
SET settings = jsonb_set(settings, '{appearance,purple}', '"#a626ff"')
WHERE settings->'appearance'->>'purple' = '#c026d3';

UPDATE oxygen.map_templates
SET settings = jsonb_set(settings, '{appearance,numberHeightMm}', '4')
WHERE (settings->'appearance'->>'numberHeightMm')::double precision = 3.5;

-- Club templates snapshot the full template as `payload`, with the
-- appearance nested under payload.settings.
UPDATE oxygen.club_map_templates
SET payload = jsonb_set(payload, '{settings,appearance,purple}', '"#a626ff"')
WHERE payload->'settings'->'appearance'->>'purple' = '#c026d3';

UPDATE oxygen.club_map_templates
SET payload = jsonb_set(payload, '{settings,appearance,numberHeightMm}', '4')
WHERE (payload->'settings'->'appearance'->>'numberHeightMm')::double precision = 3.5;
