# The plugin has no dependencies to install: it is Node and nothing else.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8099 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json icon.png ./
COPY src ./src
COPY public ./public

# The state file lives here. It is owned by the unprivileged user the plugin runs as.
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/session').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# "exec" form, so the plugin itself receives the stop signal and lets everyone back online before it exits.
CMD ["node", "src/main.js"]
