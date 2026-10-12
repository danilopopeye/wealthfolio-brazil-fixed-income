FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY static ./static
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /cdbapi .

FROM alpine:3.21
COPY --from=build /cdbapi /usr/local/bin/cdbapi
USER nobody
EXPOSE 8080
ENTRYPOINT ["cdbapi"]
