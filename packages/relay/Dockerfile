# The relay is one small always-on websocket process. No database, no state that
# outlives a flight, so it scales to exactly one instance and restarts freely.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Platforms inject PORT; default matches local dev.
ENV PORT=8791
# Unbuffered, or the relay's connect/disconnect lines never reach `fly logs`.
ENV PYTHONUNBUFFERED=1
EXPOSE 8791

# RELAY_TOKEN must be set in the environment — the relay refuses to start
# without one, so a deployment can never accidentally accept anonymous publishers.
CMD ["python", "-m", "relay"]
