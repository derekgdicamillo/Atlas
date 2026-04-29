-- Atlas Prime Sprint 3: atomic failure recorder for memory rows.

CREATE OR REPLACE FUNCTION memory_record_failure(
  p_memory_id UUID,
  p_weight    REAL,
  p_event     JSONB
) RETURNS VOID AS $$
BEGIN
  UPDATE memory
     SET demotion_pressure = demotion_pressure + p_weight,
         demotion_events   = demotion_events || jsonb_build_array(p_event)
   WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;
