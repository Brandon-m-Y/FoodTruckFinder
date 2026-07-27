-- ============================================================================
-- 0016 — make a truck takedown actually take everything down.
--
-- Found by exercising 0015's CLI against the live project rather than reasoning
-- about it. Hiding truck 8 correctly removed the truck row, its appearances and
-- its schedule from every anonymous read path — and left its reviews sitting at
-- /rest/v1/reviews?truck_id=eq.8, fully readable.
--
-- The appearances policy joins to trucks and checks status; reviews_public_read
-- (0007) only ever checked its own `status = 'visible'`. So a takedown was
-- complete for the map and incomplete for the content attached to it.
--
-- That is the wrong way round for the case that motivates hiding a truck in the
-- first place. A fake listing is usually fake because of what is written on it,
-- and the reviews are where free text lives.
--
-- truck_edits has the identical hole: a proposed description on a hidden truck
-- stayed public. Same fix.
--
-- Reviews are NOT deleted, only unreadable while the truck is hidden. Restoring
-- the truck restores them, which is what makes `show-truck` a real undo rather
-- than a partial one.
-- ============================================================================

drop policy if exists reviews_public_read on public.reviews;

create policy reviews_public_read on public.reviews
  for select to anon, authenticated
  using (
    status = 'visible'
    and exists (select 1 from public.trucks t
                 where t.id = truck_id and t.status <> 'hidden')
  );

drop policy if exists truck_edits_public_read on public.truck_edits;

create policy truck_edits_public_read on public.truck_edits
  for select to anon, authenticated
  using (
    status = 'pending'
    and exists (select 1 from public.trucks t
                 where t.id = truck_id and t.status <> 'hidden')
  );

-- The reviews index carries `where status = 'visible'`, which still matches the
-- first half of the policy. The trucks lookup is by primary key. No new index
-- is warranted at county scale; revisit if the review count ever justifies it.
