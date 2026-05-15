-- Atlas Prime Sprint 6: vector match for soft-DPO injection.

CREATE OR REPLACE FUNCTION dpo_pairs_match(
  p_query_embedding VECTOR(1536),
  p_match_count INT DEFAULT 3,
  p_domain TEXT DEFAULT NULL
) RETURNS SETOF dpo_pairs AS $$
  SELECT *
    FROM dpo_pairs
   WHERE embedding IS NOT NULL
     AND (p_domain IS NULL OR domain = p_domain)
   ORDER BY embedding <=> p_query_embedding
   LIMIT p_match_count;
$$ LANGUAGE sql STABLE;
