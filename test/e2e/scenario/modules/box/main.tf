variable "name" {}
resource "terraform_data" "this" { input = var.name }
resource "terraform_data" "tag" { input = "${var.name}-tag" }
