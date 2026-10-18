FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TZ=UTC
# Python y librerías desde los paquetes de Ubuntu (sin pip).
# python3-cryptography lo necesita PyMySQL para autenticarse en MySQL 8.4.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-requests python3-pymysql python3-cryptography ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ingestor.py .
RUN useradd --system --no-create-home ingestor
USER ingestor
EXPOSE 8000
CMD ["python3", "ingestor.py"]
