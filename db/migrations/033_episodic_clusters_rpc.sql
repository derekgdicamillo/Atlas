-- Atlas Prime Sprint 3: episodic clustering RPC for nightly promotion.

CREATE OR REPLACE FUNCTION episodic_clusters_for_promotion()
RETURNS TABLE(tag TEXT, member_ids UUID[], member_summaries TEXT[]) AS $$
  SELECT
    t.tag,
    array_agg(m.id)         AS member_ids,
    array_agg(m.summary)    AS member_summaries
  FROM memory m, unnest(m.tags) t(tag)
  WHERE m.class = 'episodic'
    AND m.created_at > NOW() - INTERVAL '30 days'
  GROUP BY t.tag
  HAVING count(*) >= 3;
$$ LANGUAGE sql STABLE;
