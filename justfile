default:
    @just --list
build:
    npm run build
test:
    npm test
lint:
    npm run lint
probe *ARGS:
    npm run probe -- {{ARGS}}
probe-baseline:
    npm run probe:baseline
docs *ARGS:
    npm run docs -- {{ARGS}}
eval-routing:
    npm run eval:routing
gate:
    npm run gate
