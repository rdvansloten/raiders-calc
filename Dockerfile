FROM nginx:1.31-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
RUN rm -r /usr/share/nginx/html/docker

EXPOSE 8080
