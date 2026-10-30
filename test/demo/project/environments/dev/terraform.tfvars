env = "dev"
services = [
  { name = "web", replicas = 1, port = 8080 },
  { name = "api", replicas = 1, port = 9000 },
  { name = "worker", replicas = 1, port = 9100 },
]
