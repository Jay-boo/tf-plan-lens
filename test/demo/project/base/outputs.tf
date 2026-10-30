output "assets_bucket" {
  value = aws_s3_bucket.assets.bucket
}

output "orders_queue" {
  value = aws_sqs_queue.orders.url
}
