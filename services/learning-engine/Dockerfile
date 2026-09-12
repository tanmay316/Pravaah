FROM python:3.11-slim

WORKDIR /app

COPY services/learning-engine/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/learning-engine/ /app/

CMD ["python", "worker.py"]
