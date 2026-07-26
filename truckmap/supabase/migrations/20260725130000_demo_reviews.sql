-- ============================================================================
-- DEMO community content — so the detail sheet has something to render before
-- the write path is live. Fictional, like the trucks it attaches to.
--
-- Also serves as a live test of trg_review_write -> recompute_truck_rating:
-- if trucks.rating_avg / rating_count are still null/0 after this migration,
-- the trigger is not firing.
--
-- TO REMOVE (with the rest of the demo data):
--   delete from public.reviews where truck_id in
--     (select id from public.trucks where slug like 'demo-%');
--   delete from public.truck_edits where truck_id in
--     (select id from public.trucks where slug like 'demo-%');
-- private.review_authors cascades from reviews.
-- ============================================================================

with new_reviews as (
  insert into public.reviews (truck_id, rating, body, author_name)
  select t.id, r.rating, r.body, r.author
  from (values
    ('demo-smoke-signal', 5, 'Brisket was gone by 7 and I understand why. Get there early.', 'Marcy R.'),
    ('demo-smoke-signal', 4, 'Great burnt ends. Line moves slow but it''s worth the wait.', 'Dev'),
    ('demo-smoke-signal', 4, null, null),
    ('demo-taco-libre',   5, 'Al pastor is the real thing. Three tacos and I was done for the day.', 'J. Alvarez'),
    ('demo-taco-libre',   4, 'Solid salsa bar. Wish they took cards.', 'anon'),
    ('demo-wandering-wok', 3, 'Fine but a bit greasy the day I went. Portions are big.', 'Sam'),
    ('demo-sugar-hauler', 5, 'The churro sundae is dangerous. Kids loved it.', 'Priya K.')
  ) as r(truck_slug, rating, body, author)
  join public.trucks t on t.slug = r.truck_slug
  returning id, truck_id
)
-- Author rows keep the one-review-per-(truck, ip_hash) model coherent. The
-- hashes are obvious placeholders, not real hashed addresses.
insert into private.review_authors (review_id, truck_id, ip_hash)
select id, truck_id, 'demo-author-' || id from new_reviews;

-- A queued description edit, so the "awaiting review" affordance is visible.
insert into public.truck_edits (truck_id, field, value, note)
select t.id, 'description',
       'Hamilton-based BBQ truck. Brisket, burnt ends, and a rotating weekend special. '
       || 'Cash and card. Usually parked downtown Thursday through Saturday.',
       'Current description is just a placeholder.'
from public.trucks t
where t.slug = 'demo-smoke-signal';
