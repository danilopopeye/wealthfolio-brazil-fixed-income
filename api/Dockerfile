FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY static ./static
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /fixed-income-api .

FROM alpine:3.21
COPY --from=build /fixed-income-api /usr/local/bin/fixed-income-api
USER nobody
EXPOSE 8080
ENTRYPOINT ["fixed-income-api"]
