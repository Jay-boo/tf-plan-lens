variable "name" {}
variable "location" {}
resource "terraform_data" "this" { input = { name = var.name, location = var.location } }
