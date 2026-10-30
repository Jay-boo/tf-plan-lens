variable "name" {
  type = string
}

resource "aws_sqs_queue" "this" {
  name                       = var.name
  visibility_timeout_seconds = 60
}

resource "aws_sqs_queue" "dlq" {
  name = "${var.name}-dlq"
}

output "url" {
  value = aws_sqs_queue.this.url
}
