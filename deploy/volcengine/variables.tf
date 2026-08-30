variable "region" {
  description = "Volcengine region, for example cn-beijing."
  type        = string
}

variable "zone_id" {
  description = "Availability zone that has inventory for the chosen instance type."
  type        = string
}

variable "image_id" {
  description = "A public Ubuntu 22.04/24.04 image ID in the selected region."
  type        = string
}

variable "instance_type" {
  description = "ECS instance type. 2 vCPU / 4 GiB or larger is recommended."
  type        = string
  default     = "ecs.g4i.large"
}

variable "key_pair_name" {
  description = "Existing ECS SSH key-pair name."
  type        = string
}

variable "project_name" {
  description = "Volcengine project."
  type        = string
  default     = "default"
}

variable "allowed_web_cidr" {
  description = "CIDR allowed to access the web UI. This must be an explicit, restricted network."
  type        = string
  validation {
    condition     = var.allowed_web_cidr != "0.0.0.0/0"
    error_message = "allowed_web_cidr must not expose this code-execution POC to the entire Internet."
  }
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH to the ECS."
  type        = string
}

variable "repository_url" {
  description = "Public Git URL of this Starter Kit repository."
  type        = string
  validation {
    condition     = startswith(var.repository_url, "https://")
    error_message = "repository_url must be an HTTPS URL."
  }
}

variable "repository_ref" {
  description = "Git branch or tag deployed by cloud-init."
  type        = string
  default     = "main"
}

variable "openrouter_api_key" {
  description = "OpenRouter API key. Supplied through TF_VAR_openrouter_api_key."
  type        = string
  sensitive   = true
}

variable "openrouter_model" {
  description = "OpenRouter model slug, for example openrouter/free."
  type        = string
  default     = "openrouter/free"
}

variable "openrouter_base_url" {
  description = "OpenRouter API base URL."
  type        = string
  default     = "https://openrouter.ai/api/v1"
}
