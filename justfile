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
gate:
    npm run gate
