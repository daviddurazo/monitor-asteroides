FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY assets/ assets/
EXPOSE 8050
# Timeout amplio: el botón "Sincronizar" espera la respuesta de la NASA.
CMD ["gunicorn", "--bind", "0.0.0.0:8050", "--workers", "2", "--timeout", "180", "app:server"]
