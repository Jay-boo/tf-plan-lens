resource "terraform_data" "lake" { input = { name = "stlake", location = "westeurope" } }
resource "terraform_data" "subnet" {
  count = 3
  input = { name = ["app", "db", "pe"][count.index], cidr = "10.0.${count.index}.0/24" }
}
module "old" {
  source = "./modules/box"
  name   = "alpha"
}
module "inst" {
  source = "./modules/box"
  count  = 2
  name   = "i${count.index}"
}
resource "terraform_data" "keep" { input = "same" }
resource "terraform_data" "gone" { input = "bye" }
