variable "env" {
  default = "qual"
}
locals {
  prefix = "rg-${var.env}-data"
  cidrs  = { for k, v in { app = 0, db = 1 } : k => "10.0.${v}.0/24" }
}
module "storage" {
  source   = "./modules/store"
  name     = "stlake"
  location = "westeurope"
}
resource "terraform_data" "subnet" {
  for_each = { app = "10.0.0.0/24", db = "10.0.1.0/24", pe = "10.0.2.0/24" }
  input    = { name = each.key, cidr = each.value }
}
module "new" {
  source = "./modules/box"
  name   = "alpha"
}
module "inst" {
  source   = "./modules/box"
  for_each = toset(["i0", "i1"])
  name     = each.key
}
resource "terraform_data" "keep" { input = "same" }
resource "terraform_data" "fresh" { input = "hello" }
