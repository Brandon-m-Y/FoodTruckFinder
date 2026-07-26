-- ============================================================================
-- DEMO SEED — throwaway data so the map has something to render during
-- development. NOT real business data.
--
-- Every truck below is fictional and named to make that obvious. Venue
-- coordinates are APPROXIMATE municipal centers in Butler County, not surveyed
-- addresses — good enough to exercise bbox queries and clustering, not good
-- enough to send anyone anywhere.
--
-- TO REMOVE (once real license data lands, see docs/FINDINGS.md):
--   delete from public.trucks where slug like 'demo-%';
--   delete from public.venues where name like '[DEMO]%';
-- Appearances and schedules cascade from trucks.
-- ============================================================================

-- --- Venues: approximate centers of real Butler County municipalities --------
insert into public.venues (name, venue_type, geom, city, state) values
  ('[DEMO] Downtown Hamilton lot',      'brewery',       extensions.ST_SetSRID(extensions.ST_MakePoint(-84.5613, 39.3995), 4326), 'Hamilton',    'OH'),
  ('[DEMO] Union Centre square',        'business_park', extensions.ST_SetSRID(extensions.ST_MakePoint(-84.4100, 39.3400), 4326), 'West Chester','OH'),
  ('[DEMO] Middletown riverfront',      'park',          extensions.ST_SetSRID(extensions.ST_MakePoint(-84.3983, 39.5151), 4326), 'Middletown',  'OH'),
  ('[DEMO] Oxford uptown',              'street',        extensions.ST_SetSRID(extensions.ST_MakePoint(-84.7452, 39.5070), 4326), 'Oxford',      'OH'),
  ('[DEMO] Fairfield commons',          'private_lot',   extensions.ST_SetSRID(extensions.ST_MakePoint(-84.5603, 39.3454), 4326), 'Fairfield',   'OH');

-- --- Trucks: fictional -------------------------------------------------------
insert into public.trucks (slug, name, cuisines, description, status, last_verified_at) values
  ('demo-taco-libre',    '[DEMO] Taco Libre',      '{tacos,mexican}',   'Fictional demo truck.', 'active', now()),
  ('demo-smoke-signal',  '[DEMO] Smoke Signal BBQ','{bbq}',             'Fictional demo truck.', 'active', now()),
  ('demo-wandering-wok', '[DEMO] Wandering Wok',   '{asian}',           'Fictional demo truck.', 'active', now()),
  ('demo-sugar-hauler',  '[DEMO] Sugar Hauler',    '{desserts,coffee}', 'Fictional demo truck.', 'active', now());

-- --- Standing weekly rules ---------------------------------------------------
-- day_of_week: 0=Sun .. 6=Sat. Times are LOCAL wall-clock (America/New_York).
insert into public.schedules (truck_id, venue_id, day_of_week, start_time, end_time)
select t.id, v.id, s.dow, s.st, s.en
from (values
  ('demo-taco-libre',    '[DEMO] Downtown Hamilton lot', 4, time '17:00', time '21:00'),
  ('demo-taco-libre',    '[DEMO] Union Centre square',   6, time '11:00', time '15:00'),
  ('demo-smoke-signal',  '[DEMO] Union Centre square',   5, time '16:00', time '21:00'),
  ('demo-wandering-wok', '[DEMO] Middletown riverfront', 3, time '11:00', time '14:00'),
  ('demo-wandering-wok', '[DEMO] Oxford uptown',         5, time '18:00', time '23:00'),
  ('demo-sugar-hauler',  '[DEMO] Fairfield commons',     0, time '12:00', time '17:00')
) as s(truck_slug, venue_name, dow, st, en)
join public.trucks t on t.slug = s.truck_slug
join public.venues v on v.name = s.venue_name;

-- --- Materialize the next 14 days + score the trucks -------------------------
select public.materialize_schedules(14);

do $$
declare r record;
begin
  for r in select id from public.trucks loop
    perform public.recompute_truck_confidence(r.id);
  end loop;
end $$;

-- --- An operator-posted one-off, starting soon --------------------------------
-- Exercises the highest-credibility plan branch (operator, base 80) and gives
-- the map at least one pin that is 'live' rather than merely 'scheduled'.
insert into public.appearances (truck_id, venue_id, geom, starts_at, ends_at, source, asserted_at, status)
select t.id, v.id, v.geom, now() - interval '30 minutes', now() + interval '3 hours',
       'operator', now() - interval '2 hours', 'confirmed'
from public.trucks t, public.venues v
where t.slug = 'demo-smoke-signal' and v.name = '[DEMO] Downtown Hamilton lot';
