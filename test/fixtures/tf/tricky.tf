# resource "commented" "out" {
// module "nope" {
/* resource "z" "w" {
   still comment } */
resource "azurerm_storage_account" "this" {
  name = "a{b}"
  tags = { x = "${var.x}", y = "${ {a=1} }" }
  dynamic "rule" {
    for_each = var.rules
    content {
      name = rule.value
    }
  }
}

locals {
  script = <<EOF
resource "x" "y" {
}
}
EOF
  other = <<-EOT
    }}}
    EOT
}

data "azurerm_client_config" "current" {}

module "lakebase" {
  source = "./modules/lakebase"
  # } brace in a comment
  note   = "}" // } and here
}
