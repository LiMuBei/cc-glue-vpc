// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from 'constructs';
import { App, TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Vpc } from '@cdktf/provider-aws/lib/vpc';

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, 'aws', {
      region: 'eu-central-1'
    });

    // This is the VPC we want to deploy our resources into
    new Vpc(this, 'vpc', {
      cidrBlock: '10.0.0.0/16'
    });
  }
}

const app = new App();
new MyStack(app, 'glue-vpc-article');
app.synth();
