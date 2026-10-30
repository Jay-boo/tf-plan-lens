env = "prod"
services = [
  { name = "web", replicas = 3, port = 8080 },
  { name = "api", replicas = 4, port = 9000 },
  { name = "worker", replicas = 2, port = 9100 },
]
