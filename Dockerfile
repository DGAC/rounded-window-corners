FROM debian:trixie-slim

RUN apt -y update && \
    apt -y install nodejs gettext npm just libglib2.0-bin zip
WORKDIR /code
