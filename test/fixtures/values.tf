variable "env" {}
variable "subnets" {
  default = [{ name = "app" }] # a list
}
locals {
  rg_name = "rg-${var.env}-data" # comment
  subnets = { for s in var.subnets : s.name => s
    if s.name != "skip" }
  script  = <<EOT
  name = not an attribute
EOT
  tags    = merge(var.tags, { "a=b" = "x" })
}
/* locals { fake = 1 } */
resource "azurerm_subnet" "s" {
  for_each = {
    for k, v in local.subnets : k => v # trailing
  }
  name = each.key
  dynamic "x" {
    for_each = each.value.rules
  }
}
resource "terraform_data" "c" {
  count = length(var.subnets)
}
module "m" {
  source   = "./m"
  for_each = toset(["a"])
}
output "url" {
  value = "https://${local.rg_name}.example"
}
output "per" {
  value = each.key
}
