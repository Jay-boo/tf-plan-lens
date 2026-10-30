locals {
  name     = "acme-shop-${var.env}"
  services = { for s in var.services : s.name => s }
  tags = {
    project = "acme-shop"
    env     = var.env
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "${local.name}-assets"
  tags   = local.tags
}

resource "aws_dynamodb_table" "orders" {
  name         = "${local.name}-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "order_id"

  attribute {
    name = "order_id"
    type = "S"
  }
}

resource "aws_sqs_queue" "orders" {
  name                       = "${local.name}-orders"
  visibility_timeout_seconds = 60
}

resource "aws_sqs_queue" "orders_dlq" {
  name = "${local.name}-orders-dlq"
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_ssm_parameter" "replicas" {
  for_each = local.services
  name     = "/${local.name}/${each.key}/replicas"
  type     = "String"
  value    = tostring(each.value.replicas)
}

resource "aws_iam_role" "worker" {
  name = "${local.name}-worker"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}
