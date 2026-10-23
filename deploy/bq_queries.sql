-- Example BigQuery analytics (connect the table to Looker Studio for a live dashboard).

-- 1. Community waste rate by category (where does food get thrown away?)
SELECT category,
       COUNTIF(kind = 'wasted') AS wasted,
       COUNT(*) AS total,
       ROUND(SAFE_DIVIDE(COUNTIF(kind = 'wasted'), COUNT(*)), 3) AS waste_rate,
       ROUND(SUM(IF(kind = 'wasted', cost, 0)), 2) AS money_lost
FROM `pantrypilot.waste_events`
GROUP BY category
ORDER BY waste_rate DESC;

-- 2. Weekly CO2e avoided vs. lost
SELECT DATE_TRUNC(DATE(ts), WEEK) AS week,
       ROUND(SUM(IF(kind != 'wasted', co2_kg, 0)), 2) AS co2_avoided_kg,
       ROUND(SUM(IF(kind = 'wasted', co2_kg, 0)), 2) AS co2_lost_kg
FROM `pantrypilot.waste_events`
GROUP BY week
ORDER BY week;

-- 3. Rescue rate: share of items eaten before expiry because of a nudge
SELECT ROUND(SAFE_DIVIDE(COUNTIF(kind = 'rescued'), COUNTIF(kind != 'wasted')), 3) AS rescue_share
FROM `pantrypilot.waste_events`;
