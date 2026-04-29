-- Atlas Prime Sprint 3: RPCs for procedures retrieval and outcome recording.

CREATE OR REPLACE FUNCTION procedures_match(
  p_query_embedding VECTOR(1536),
  p_match_count INT DEFAULT 20
) RETURNS SETOF procedures AS $$
  SELECT *
    FROM procedures
   WHERE goal_embedding IS NOT NULL
   ORDER BY goal_embedding <=> p_query_embedding
   LIMIT p_match_count;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION procedure_record_outcome(
  p_procedure_id UUID,
  p_success BOOLEAN
) RETURNS VOID AS $$
BEGIN
  IF p_success THEN
    UPDATE procedures
       SET alpha = alpha + 1,
           use_count = use_count + 1,
           last_used_at = NOW(),
           updated_at = NOW()
     WHERE id = p_procedure_id;
  ELSE
    UPDATE procedures
       SET beta = beta + 1,
           use_count = use_count + 1,
           last_used_at = NOW(),
           updated_at = NOW()
     WHERE id = p_procedure_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
