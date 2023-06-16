// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from 'constructs';
import { App, TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Vpc } from '@cdktf/provider-aws/lib/vpc';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { RdsCluster } from '@cdktf/provider-aws/lib/rds-cluster';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { SecurityGroupRule } from '@cdktf/provider-aws/lib/security-group-rule';
import { Password } from '@cdktf/provider-random/lib/password';
import { SecretsmanagerSecret } from '@cdktf/provider-aws/lib/secretsmanager-secret';
import { SecretsmanagerSecretVersion } from '@cdktf/provider-aws/lib/secretsmanager-secret-version';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Subnet } from '@cdktf/provider-aws/lib/subnet';
import { DbSubnetGroup } from '@cdktf/provider-aws/lib/db-subnet-group';

class MyStack extends TerraformStack {
  readonly vpc: Vpc;
  readonly rdsCluster: RdsCluster;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, 'aws', {
      region: 'eu-central-1'
    });

    new RandomProvider(this, 'random');

    // This is the VPC we want to deploy our resources into
    this.vpc = new Vpc(this, 'vpc', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true
    });

    // Create isolated subnets for the RDS database
    const rdsSubnetA = new Subnet(this, 'rds-subnet-a', {
      vpcId: this.vpc.id,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: 'eu-central-1a',
      mapPublicIpOnLaunch: false
    });
    const rdsSubnetB = new Subnet(this, 'rds-subnet-b', {
      vpcId: this.vpc.id,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: 'eu-central-1b',
      mapPublicIpOnLaunch: false
    });

    // This is the S3 bucket where the Glue job script and resources will live
    new S3Bucket(this, 'glue-bucket', {
      bucket: 'glue-bucket',
      acl: 'private'
    });

    // This is the security group the Glue job will use to access the RDS database
    const glueSecurityGroup = new SecurityGroup(this, 'glue-security-group', {
      name: 'glue-security-group',
      description: 'Security group for Glue job',
      vpcId: this.vpc.id
    });

    // The RDS cluster
    this.rdsCluster = this.setupRdsCluster([rdsSubnetA.id, rdsSubnetB.id], glueSecurityGroup);
  }

  private setupRdsCluster(subnetIds: string[], glueSecurityGroup: SecurityGroup) {
    // This is the security group for the RDS database
    const rdsSecurityGroup = this.setupRdsSecurity(this.vpc, this, glueSecurityGroup);

    const rdsMasterUsername = 'gluedbadmin';
    // The RDS master user password
    const rdsMasterUserPassword = new Password(this, 'rds-master-user-password', {
      length: 48,
      special: false
    });
    // NOTE: we will be using the master user to access the RDS, DO NOT DO THIS IN PRODUCTION!!!

    // RDS subnet group
    const subnetGroup = new DbSubnetGroup(this, 'rds-subnet-group', {
      name: 'rds-subnet-group',
      subnetIds: subnetIds
    });

    // This is the RDS database where the Glue job will write to
    const rdsCluster = new RdsCluster(this, 'rds-cluster', {
      clusterIdentifier: 'rds-cluster',
      engine: 'aurora-postgresql',
      engineMode: 'provisioned',
      engineVersion: '15.2',
      databaseName: 'glue',
      masterUsername: rdsMasterUsername,
      masterPassword: rdsMasterUserPassword.result,
      vpcSecurityGroupIds: [rdsSecurityGroup.id],
      dbSubnetGroupName: subnetGroup.name,
      skipFinalSnapshot: true
    });

    // Store master user credentials in secrets manager
    const rdsMasterUserSecret = new SecretsmanagerSecret(this, 'rds-master-user-secret', {
      name: 'rds-master-user-secret',
      description: 'RDS master user secret'
    });
    new SecretsmanagerSecretVersion(this, 'rds-master-user-secret-version', {
      secretId: rdsMasterUserSecret.id,
      secretString: JSON.stringify({
        dbClusterIdentifier: rdsCluster.clusterIdentifier,
        password: rdsMasterUserPassword.result,
        dbName: rdsCluster.databaseName,
        port: 5432,
        host: rdsCluster.endpoint,
        username: rdsMasterUsername
      })
    });

    return rdsCluster;
  }

  private setupRdsSecurity(vpc: Vpc, scope: Construct, glueSecurityGroup: SecurityGroup) {
    const rdsSecurityGroup = new SecurityGroup(this, 'rds-security-group', {
      name: 'rds-security-group',
      description: 'Security group for RDS database',
      vpcId: vpc.id
    });

    // Disallow all outbound traffic from the RDS database
    new SecurityGroupRule(scope, `rds-disallow-all-outbound-rule`, {
      securityGroupId: rdsSecurityGroup.id,
      description: 'Disallow all outbound traffic',
      type: 'egress',
      protocol: 'icmp',
      fromPort: 252,
      toPort: 86,
      cidrBlocks: ['255.255.255.255/32']
    });

    // This is the security ingress group rule allowing access to the RDS database from the Glue job
    new SecurityGroupRule(this, 'rds-security-group-rule', {
      type: 'ingress',
      fromPort: 5432,
      toPort: 5432,
      protocol: 'tcp',
      securityGroupId: rdsSecurityGroup.id,
      sourceSecurityGroupId: glueSecurityGroup.id
    });
    // This is the security group egress rule allowing access to the Glue job from the RDS database
    new SecurityGroupRule(this, 'glue-security-group-rule', {
      type: 'egress',
      fromPort: 5432,
      toPort: 5432,
      protocol: 'tcp',
      securityGroupId: rdsSecurityGroup.id,
      sourceSecurityGroupId: glueSecurityGroup.id
    });
    return rdsSecurityGroup;
  }
}

const app = new App();
new MyStack(app, 'glue-vpc-article');
app.synth();
