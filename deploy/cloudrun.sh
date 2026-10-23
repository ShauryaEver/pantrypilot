#!/usr/bin/env bash
# Deploy PantryPilot to Google Cloud Run. Secrets live in Secret Manager (never in the image or env files) and the
# service runs as a dedicated least-privilege service account.
#
# Usage:
#   PROJECT_ID=my-proj REGION=asia-south1 \
#   SUPABASE_URL=https://xxxx.supabase.co \
#   FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=my-proj.firebaseapp.com FIREBASE_APP_ID=... \
#   ./deploy/cloudrun.sh
# First run prompts (hidden input) for the Supabase service-role key and, optionally, a Gemini API key.
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-south1}"
VERTEX_LOCATION="${VERTEX_LOCATION:-us-central1}"
SERVICE="${SERVICE:-pantrypilot}"
SA_NAME="pantrypilot-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com aiplatform.googleapis.com bigquery.googleapis.com firestore.googleapis.com

# Dedicated service account: only the roles the app needs.
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create "$SA_NAME" --display-name "PantryPilot Cloud Run"
for ROLE in roles/aiplatform.user roles/bigquery.dataEditor roles/bigquery.jobUser roles/datastore.user roles/firebaseauth.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$ROLE" --condition=None >/dev/null
done

# put_secret NAME [VALUE]: create or add a new version. Value is read hidden from the terminal if not supplied.
put_secret() {
  local name="$1" value="${2:-}"
  if [ -z "$value" ]; then read -rsp "$name: " value; echo; fi
  if gcloud secrets describe "$name" >/dev/null 2>&1; then printf %s "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else printf %s "$value" | gcloud secrets create "$name" --data-file=- >/dev/null; fi
  gcloud secrets add-iam-policy-binding "$name" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
}
secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }

secret_exists pp-jwt-secret || put_secret pp-jwt-secret "$(openssl rand -hex 32)"
secret_exists pp-bq-salt    || put_secret pp-bq-salt "$(openssl rand -hex 16)"
secret_exists pp-supabase-service-key || put_secret pp-supabase-service-key
gcloud secrets add-iam-policy-binding pp-jwt-secret --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
gcloud secrets add-iam-policy-binding pp-bq-salt --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null

# Gemini runs through Vertex AI (no API key). Set USE_GEMINI_KEY=1 to use an AI Studio key instead.
SECRETS="JWT_SECRET=pp-jwt-secret:latest,BQ_SALT=pp-bq-salt:latest,SUPABASE_SERVICE_ROLE_KEY=pp-supabase-service-key:latest"
ENVV="NODE_ENV=production,GEMINI_MODEL=gemini-2.5-flash,GEMINI_PARSE_MODEL=gemini-2.5-flash-lite,AI_DAILY_LIMIT=${AI_DAILY_LIMIT:-50}"
ENVV+=",SUPABASE_URL=${SUPABASE_URL:?set SUPABASE_URL}"
ENVV+=",BQ_STREAM=true,BQ_DATASET=pantrypilot,FIRESTORE_AGENT_LOG=${FIRESTORE_AGENT_LOG:-false}"
ENVV+=",FIREBASE_PROJECT_ID=${PROJECT_ID}"
if [ -n "${FIREBASE_API_KEY:-}" ]; then
  ENVV+=",FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN:?set FIREBASE_AUTH_DOMAIN},FIREBASE_APP_ID=${FIREBASE_APP_ID:?set FIREBASE_APP_ID}"
fi
if [ "${USE_GEMINI_KEY:-0}" = "1" ]; then
  secret_exists pp-gemini-key || put_secret pp-gemini-key
  SECRETS+=",GEMINI_API_KEY=pp-gemini-key:latest"
else
  ENVV+=",GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION}"
fi

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --max-instances 3 --min-instances 0 \
  --cpu 1 --memory 512Mi --concurrency 40 --timeout 60 \
  --set-env-vars "$ENVV" \
  --set-secrets "$SECRETS"

echo "Deployed. Check readiness: curl \$(gcloud run services describe $SERVICE --region $REGION --format 'value(status.url)')/api/ready"
echo "Optional CDN front + Firestore rules: firebase deploy --only hosting,firestore:rules"
