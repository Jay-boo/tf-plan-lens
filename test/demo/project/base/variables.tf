variable "env" {
  description = "dev or prod"
  type        = string
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "services" {
  description = "The shop's services and how they run"
  type = list(object({
    name     = string
    replicas = number
    port     = number
  }))
}
